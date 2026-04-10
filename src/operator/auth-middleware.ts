/**
 * Operator Auth Middleware — JWT-based authentication for dashboard/portal
 *
 * Separate from the caller AuthTier system (voice sessions).
 * This protects HTTP/WebSocket operator endpoints.
 */

import { createHash, randomBytes } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Logger } from 'pino';
import type { Database } from '../db/client.js';
import { operatorUsers, operatorSessions } from '../db/schema.js';
import { eq, and, gt } from 'drizzle-orm';
import type { OperatorRole, OperatorSession, PermissionAction } from './types.js';
import { ROLE_HIERARCHY, ROLE_PERMISSIONS } from './types.js';

// Extend Express Request to carry operator session
declare global {
  namespace Express {
    interface Request {
      operator?: OperatorSession;
    }
  }
}

// ============================================================================
// JWT-like Token (simple HMAC — no external dependency)
// ============================================================================

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function signToken(payload: OperatorSession, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const exp = Buffer.from(String(Date.now() + TOKEN_TTL_MS)).toString('base64url');
  const body = `${data}.${exp}`;
  const sig = createHash('sha256').update(`${body}.${secret}`).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token: string, secret: string): OperatorSession | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [data, exp, sig] = parts;
  const expectedSig = createHash('sha256').update(`${data}.${exp}.${secret}`).digest('base64url');
  if (sig !== expectedSig) return null;

  const expiry = Number(Buffer.from(exp, 'base64url').toString());
  if (Date.now() > expiry) return null;

  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString()) as OperatorSession;
  } catch {
    return null;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').substring(0, 64);
}

// Simple password hashing with salt (no bcrypt dependency)
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const computed = createHash('sha256').update(`${salt}:${password}`).digest('hex');
  return computed === hash;
}

// ============================================================================
// Auth Service
// ============================================================================

export class OperatorAuthService {
  private db: Database;
  private secret: string;
  private logger: Logger;

  constructor(db: Database, secret: string, logger: Logger) {
    this.db = db;
    this.secret = secret;
    this.logger = logger.child({ component: 'OperatorAuth' });
  }

  /** Bootstrap: create default admin if no users exist */
  async ensureDefaultAdmin(email: string, password: string, name: string = 'Admin'): Promise<void> {
    const existing = await this.db.select({ id: operatorUsers.id })
      .from(operatorUsers).limit(1);
    if (existing.length > 0) return;

    await this.db.insert(operatorUsers).values({
      email,
      passwordHash: hashPassword(password),
      name,
      role: 'superadmin',
      isActive: true,
    });
    this.logger.info({ email }, 'Default admin created');
  }

  /** Login — returns JWT token */
  async login(email: string, password: string, ip?: string, userAgent?: string): Promise<{ token: string; user: OperatorSession } | null> {
    const users = await this.db.select()
      .from(operatorUsers)
      .where(and(eq(operatorUsers.email, email), eq(operatorUsers.isActive, true)))
      .limit(1);

    const user = users[0];
    if (!user || !verifyPassword(password, user.passwordHash)) {
      this.logger.warn({ email }, 'Login failed');
      return null;
    }

    const session: OperatorSession = {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role as OperatorRole,
    };

    const token = signToken(session, this.secret);

    // Track session in DB
    await this.db.insert(operatorSessions).values({
      userId: user.id,
      tokenHash: hashToken(token),
      ipAddress: ip ?? null,
      userAgent: userAgent ?? null,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });

    // Update last login
    await this.db.update(operatorUsers)
      .set({ lastLoginAt: new Date() } as any)
      .where(eq(operatorUsers.id, user.id));

    this.logger.info({ email, role: user.role }, 'Operator logged in');
    return { token, user: session };
  }

  /** Logout — revoke token */
  async logout(token: string): Promise<void> {
    const hash = hashToken(token);
    await this.db.update(operatorSessions)
      .set({ revoked: true } as any)
      .where(eq(operatorSessions.tokenHash, hash));
  }

  /** Verify token from request */
  verify(token: string): OperatorSession | null {
    return verifyToken(token, this.secret);
  }

  /** Create a new operator user */
  async createUser(email: string, password: string, name: string, role: OperatorRole): Promise<string> {
    const [user] = await this.db.insert(operatorUsers).values({
      email,
      passwordHash: hashPassword(password),
      name,
      role,
      isActive: true,
    }).returning({ id: operatorUsers.id });
    this.logger.info({ email, role }, 'Operator user created');
    return user.id;
  }

  /** List all operator users */
  async listUsers(): Promise<any[]> {
    return this.db.select({
      id: operatorUsers.id,
      email: operatorUsers.email,
      name: operatorUsers.name,
      role: operatorUsers.role,
      isActive: operatorUsers.isActive,
      lastLoginAt: operatorUsers.lastLoginAt,
      createdAt: operatorUsers.createdAt,
    }).from(operatorUsers);
  }
}

// ============================================================================
// Express Middleware
// ============================================================================

export function hasPermission(role: OperatorRole, action: PermissionAction): boolean {
  return ROLE_PERMISSIONS[role]?.includes(action) ?? false;
}

export function hasMinRole(userRole: OperatorRole, minRole: OperatorRole): boolean {
  return ROLE_HIERARCHY.indexOf(userRole) >= ROLE_HIERARCHY.indexOf(minRole);
}

/**
 * Middleware: require authenticated operator with specific permission.
 */
export function requirePermission(action: PermissionAction, authService: OperatorAuthService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const session = authService.verify(token);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (!hasPermission(session.role, action)) {
      res.status(403).json({ error: 'Insufficient permissions', required: action, role: session.role });
      return;
    }

    req.operator = session;
    next();
  };
}

/**
 * Middleware: require authenticated operator (any role).
 */
export function requireAuth(authService: OperatorAuthService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const session = authService.verify(token);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    req.operator = session;
    next();
  };
}
