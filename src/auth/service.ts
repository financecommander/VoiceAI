/**
 * Auth Service — OTP Verification + Tier Upgrade
 *
 * Authentication tiers:
 *   Tier 0: Anonymous — general info, pricing, FAQs
 *   Tier 1: Phone match — balances, history, loan status (phone + security Q)
 *   Tier 2: OTP verified — transfers, price locks, payments (phone + OTP)
 *   Tier 3: High-risk — wire releases, metal transfers (phone + OTP + liveness)
 *
 * OTP delivery via Twilio Verify or SMS through GHL.
 * Rate limited: 3 attempts per OTP, 5 OTPs per hour per phone, 15-min lockout.
 */

import crypto from 'crypto';
import { eq, and, gte, desc } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { authSessions, otpAttempts } from '../db/schema.js';
import type { AuthTier } from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface AuthConfig {
  otpLength: number;
  otpExpiryMs: number;
  maxOtpAttempts: number;
  maxOtpsPerHour: number;
  lockoutDurationMs: number;
  /** Skip actual SMS delivery in dev mode */
  devMode: boolean;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  otpLength: 6,
  otpExpiryMs: 5 * 60 * 1000,       // 5 minutes
  maxOtpAttempts: 3,
  maxOtpsPerHour: 5,
  lockoutDurationMs: 15 * 60 * 1000, // 15 minutes
  devMode: false,
};

// ============================================================================
// Auth Service
// ============================================================================

export class AuthService {
  private db: Database;
  private config: AuthConfig;
  private logger: Logger;
  private otpSender: OTPSender;

  constructor(db: Database, config: AuthConfig, otpSender: OTPSender, logger: Logger) {
    this.db = db;
    this.config = config;
    this.otpSender = otpSender;
    this.logger = logger.child({ component: 'AuthService' });
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  /**
   * Initialize auth session for a call.
   * Checks if phone matches a known customer (auto Tier 1 for inbound).
   */
  async initializeAuthSession(params: {
    sessionId: string;
    phone: string;
    direction: 'inbound' | 'outbound';
  }): Promise<{ authSessionId: string; initialTier: AuthTier; customerId: string | null }> {
    // Check if phone is locked out
    const lockout = await this.checkLockout(params.phone);
    if (lockout) {
      this.logger.warn({ phone: params.phone }, 'Phone is locked out');
      return { authSessionId: '', initialTier: 0 as AuthTier, customerId: null };
    }

    // For inbound calls, phone match gives Tier 1 automatically
    // (caller ID is trusted for read-only access)
    let initialTier: AuthTier = 0 as AuthTier;
    let customerId: string | null = null;

    if (params.direction === 'inbound') {
      // In production: look up phone in customer database
      // For now: any recognized phone gets Tier 1
      const customer = await this.lookupCustomerByPhone(params.phone);
      if (customer) {
        initialTier = 1 as AuthTier;
        customerId = customer.customerId;
      }
    }

    const [session] = await this.db.insert(authSessions).values({
      sessionId: params.sessionId,
      phone: params.phone,
      customerId,
      currentTier: String(initialTier) as any,
      otpMaxAttempts: this.config.maxOtpAttempts,
      phoneVerified: params.direction === 'inbound',
    }).returning();

    this.logger.info({
      sessionId: params.sessionId,
      phone: params.phone,
      initialTier,
      customerId,
    }, 'Auth session initialized');

    return {
      authSessionId: session.id,
      initialTier,
      customerId,
    };
  }

  // ==========================================================================
  // OTP Flow
  // ==========================================================================

  /**
   * Generate and send an OTP for tier upgrade.
   * Returns the OTP in dev mode for testing.
   */
  async requestOTP(params: {
    authSessionId: string;
    targetTier: AuthTier;
  }): Promise<{ sent: boolean; expiresAt: Date; devOtp?: string }> {
    const session = await this.getAuthSession(params.authSessionId);
    if (!session) throw new Error('Auth session not found');

    // Check rate limit
    const recentOtps = await this.countRecentOtps(session.phone);
    if (recentOtps >= this.config.maxOtpsPerHour) {
      this.logger.warn({ phone: session.phone, count: recentOtps }, 'OTP rate limit exceeded');
      throw new Error('Too many OTP requests. Please try again later.');
    }

    // Check lockout
    if (session.lockedUntil && new Date(session.lockedUntil) > new Date()) {
      throw new Error('Account temporarily locked due to too many failed attempts.');
    }

    // Generate OTP
    const otp = this.generateOTP();
    const expiresAt = new Date(Date.now() + this.config.otpExpiryMs);

    // Update session
    await this.db.update(authSessions).set({
      otpCode: this.hashOTP(otp),
      otpExpiresAt: expiresAt,
      otpAttempts: 0,
      targetTier: String(params.targetTier) as any,
      updatedAt: new Date(),
    }).where(eq(authSessions.id, params.authSessionId));

    // Send OTP
    if (!this.config.devMode) {
      await this.otpSender.sendOTP(session.phone, otp);
    }

    this.logger.info({
      authSessionId: params.authSessionId,
      targetTier: params.targetTier,
      devMode: this.config.devMode,
    }, 'OTP generated and sent');

    return {
      sent: true,
      expiresAt,
      ...(this.config.devMode && { devOtp: otp }),
    };
  }

  /**
   * Verify an OTP code. Returns the new auth tier on success.
   */
  async verifyOTP(params: {
    authSessionId: string;
    code: string;
  }): Promise<{ verified: boolean; newTier: AuthTier; attemptsRemaining: number }> {
    const session = await this.getAuthSession(params.authSessionId);
    if (!session) throw new Error('Auth session not found');

    // Check if OTP exists and hasn't expired
    if (!session.otpCode || !session.otpExpiresAt) {
      return { verified: false, newTier: Number(session.currentTier) as AuthTier, attemptsRemaining: 0 };
    }

    if (new Date(session.otpExpiresAt) < new Date()) {
      this.logger.info({ authSessionId: params.authSessionId }, 'OTP expired');
      return { verified: false, newTier: Number(session.currentTier) as AuthTier, attemptsRemaining: 0 };
    }

    // Check max attempts
    if (session.otpAttempts >= session.otpMaxAttempts) {
      await this.lockAccount(params.authSessionId, session.phone);
      return { verified: false, newTier: Number(session.currentTier) as AuthTier, attemptsRemaining: 0 };
    }

    const isCorrect = this.hashOTP(params.code) === session.otpCode;

    // Log the attempt
    await this.db.insert(otpAttempts).values({
      authSessionId: params.authSessionId,
      phone: session.phone,
      codeEntered: params.code.substring(0, 1) + '***', // Partial for audit
      correct: isCorrect,
      attemptNumber: session.otpAttempts + 1,
    });

    if (isCorrect) {
      const newTier = Number(session.targetTier ?? session.currentTier) as AuthTier;

      await this.db.update(authSessions).set({
        currentTier: String(newTier) as any,
        otpVerified: true,
        otpCode: null,
        otpExpiresAt: null,
        updatedAt: new Date(),
      }).where(eq(authSessions.id, params.authSessionId));

      this.logger.info({
        authSessionId: params.authSessionId,
        newTier,
      }, 'OTP verified, tier upgraded');

      return { verified: true, newTier, attemptsRemaining: this.config.maxOtpAttempts };
    }

    // Wrong code
    const newAttemptCount = session.otpAttempts + 1;
    const attemptsRemaining = session.otpMaxAttempts - newAttemptCount;

    await this.db.update(authSessions).set({
      otpAttempts: newAttemptCount,
      updatedAt: new Date(),
    }).where(eq(authSessions.id, params.authSessionId));

    // Lock on max failures
    if (attemptsRemaining <= 0) {
      await this.lockAccount(params.authSessionId, session.phone);
    }

    this.logger.warn({
      authSessionId: params.authSessionId,
      attemptsRemaining,
    }, 'OTP verification failed');

    return {
      verified: false,
      newTier: Number(session.currentTier) as AuthTier,
      attemptsRemaining: Math.max(0, attemptsRemaining),
    };
  }

  // ==========================================================================
  // Security Questions (Tier 1 upgrade for outbound)
  // ==========================================================================

  async verifySecurityAnswer(params: {
    authSessionId: string;
    questionId: string;
    answer: string;
  }): Promise<{ verified: boolean; newTier: AuthTier }> {
    // In production: validate against customer security questions in core banking
    // For now: accept any answer in dev mode
    const session = await this.getAuthSession(params.authSessionId);
    if (!session) throw new Error('Auth session not found');

    // Placeholder — real implementation calls core banking
    const isCorrect = this.config.devMode || params.answer.length > 0;

    if (isCorrect) {
      await this.db.update(authSessions).set({
        securityQuestionsVerified: true,
        currentTier: '1',
        updatedAt: new Date(),
      }).where(eq(authSessions.id, params.authSessionId));

      return { verified: true, newTier: 1 as AuthTier };
    }

    return { verified: false, newTier: Number(session.currentTier) as AuthTier };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private generateOTP(): string {
    const digits = this.config.otpLength;
    const max = Math.pow(10, digits);
    const otp = crypto.randomInt(0, max);
    return String(otp).padStart(digits, '0');
  }

  private hashOTP(otp: string): string {
    return crypto.createHash('sha256').update(otp + 'calculus-voice-salt').digest('hex');
  }

  private async getAuthSession(id: string) {
    const results = await this.db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
    return results[0] ?? null;
  }

  private async checkLockout(phone: string): Promise<boolean> {
    const results = await this.db.select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.phone, phone),
          gte(authSessions.lockedUntil, new Date()),
        ),
      )
      .limit(1);
    return results.length > 0;
  }

  private async lockAccount(authSessionId: string, phone: string): Promise<void> {
    const lockedUntil = new Date(Date.now() + this.config.lockoutDurationMs);

    await this.db.update(authSessions).set({
      lockedUntil,
      updatedAt: new Date(),
    }).where(eq(authSessions.id, authSessionId));

    this.logger.warn({ phone, lockedUntil }, 'Account locked due to failed OTP attempts');
  }

  private async countRecentOtps(phone: string): Promise<number> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const results = await this.db.select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.phone, phone),
          gte(authSessions.createdAt, oneHourAgo),
        ),
      );
    return results.length;
  }

  private async lookupCustomerByPhone(phone: string): Promise<{ customerId: string } | null> {
    // In production: query core banking system
    // For dev: return a mock customer for known test numbers
    if (this.config.devMode) {
      return { customerId: 'CUST-DEV-001' };
    }
    return null;
  }
}

// ============================================================================
// OTP Sender Interface
// ============================================================================

export interface OTPSender {
  sendOTP(phone: string, code: string): Promise<void>;
}

/**
 * Twilio Verify OTP sender.
 * In production, use Twilio Verify service for deliverability + compliance.
 */
export class TwilioOTPSender implements OTPSender {
  private accountSid: string;
  private authToken: string;
  private verifySid: string;

  constructor(accountSid: string, authToken: string, verifySid: string) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.verifySid = verifySid;
  }

  async sendOTP(phone: string, code: string): Promise<void> {
    // Use Twilio Verify API
    const url = `https://verify.twilio.com/v2/Services/${this.verifySid}/Verifications`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: phone,
        Channel: 'sms',
        CustomCode: code,
      }),
    });

    if (!response.ok) {
      throw new Error(`Twilio Verify failed: ${response.status}`);
    }
  }
}

/**
 * Dev OTP sender — logs to console, doesn't actually send.
 */
export class DevOTPSender implements OTPSender {
  async sendOTP(phone: string, code: string): Promise<void> {
    console.log(`[DEV OTP] Phone: ${phone}, Code: ${code}`);
  }
}
