import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AuthUser {
  id: string;
  username: string;
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  csrfToken: string;
  expiresAt: number;
}

export interface CreatedSession extends AuthSession {
  /** Only returned when creating a session; never saved to disk. */
  token: string;
}

export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

interface PasswordHash {
  version: 1;
  algorithm: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  key: string;
}

interface StoredUser extends AuthUser {
  password: PasswordHash;
}

interface StoredSession {
  tokenHash: string;
  userId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

interface AuthState {
  version: 1;
  users: StoredUser[];
  sessions: StoredSession[];
}

export interface AuthOptions {
  registrationSecret?: string;
  sessionTtlMs?: number;
  now?: () => number;
}

const PARAMETERS = { N: 131_072, r: 8, p: 1 } as const;
const HASH_BYTES = 64;
const MAX_SESSIONS = 10;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const HEX_32 = /^[a-f0-9]{64}$/;
const HEX_64 = /^[a-f0-9]{128}$/;
const USERNAME = /^[a-z0-9_-]{3,32}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Bounds CPU and memory consumption across every store in this process. */
class PasswordOperations {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 2) {
      if (this.waiting.length >= 8) throw new AuthError(429, 'Authentication is busy. Try again shortly.');
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const passwordOperations = new PasswordOperations();

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function derive(password: string, salt: string): Promise<Buffer> {
  return passwordOperations.run(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'hex'), HASH_BYTES, { ...PARAMETERS, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  }));
}

async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(32).toString('hex');
  const key = await derive(password, salt);
  return { version: 1, algorithm: 'scrypt', ...PARAMETERS, salt, key: key.toString('hex') };
}

async function verifyPassword(password: string, hash: PasswordHash): Promise<boolean> {
  const key = await derive(password, hash.salt);
  return timingSafeEqual(key, Buffer.from(hash.key, 'hex'));
}

function publicUser(user: StoredUser): AuthUser {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

function canonicalUsername(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{3,32}$/.test(value)) return null;
  const username = value.toLowerCase();
  return USERNAME.test(username) ? username : null;
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 256;
}

function passwordMatches(left: PasswordHash, right: PasswordHash): boolean {
  return left.salt === right.salt && left.key === right.key;
}

function parseState(value: unknown): AuthState {
  const fail = () => { throw new Error('Saved authentication data has an unsupported or invalid format.'); };
  if (!value || typeof value !== 'object') return fail();
  const state = value as AuthState;
  if (state.version !== 1 || !Array.isArray(state.users) || !Array.isArray(state.sessions)) return fail();
  const userIds = new Set<string>();
  const usernames = new Set<string>();
  const tokens = new Set<string>();
  for (const user of state.users) {
    if (!user || typeof user !== 'object' || typeof user.id !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(user.id)
      || typeof user.username !== 'string' || !USERNAME.test(user.username)
      || typeof user.createdAt !== 'string' || !Number.isFinite(Date.parse(user.createdAt))
      || userIds.has(user.id) || usernames.has(user.username)) return fail();
    const hash = user.password;
    if (!hash || hash.version !== 1 || hash.algorithm !== 'scrypt'
      || hash.N !== PARAMETERS.N || hash.r !== PARAMETERS.r || hash.p !== PARAMETERS.p
      || typeof hash.salt !== 'string' || !HEX_32.test(hash.salt)
      || typeof hash.key !== 'string' || !HEX_64.test(hash.key)) return fail();
    userIds.add(user.id);
    usernames.add(user.username);
  }
  for (const session of state.sessions) {
    if (!session || typeof session !== 'object' || typeof session.tokenHash !== 'string' || !HEX_32.test(session.tokenHash)
      || tokens.has(session.tokenHash) || typeof session.userId !== 'string' || !userIds.has(session.userId)
      || typeof session.csrfToken !== 'string' || !HEX_32.test(session.csrfToken)
      || !Number.isSafeInteger(session.createdAt) || !Number.isSafeInteger(session.expiresAt)
      || session.expiresAt <= session.createdAt) return fail();
    tokens.add(session.tokenHash);
  }
  // Copy only known fields; accidental extra fields are never written back.
  return {
    version: 1,
    users: state.users.map(user => ({ ...publicUser(user), password: { version: 1, algorithm: 'scrypt', ...PARAMETERS, salt: user.password.salt, key: user.password.key } })),
    sessions: state.sessions.map(session => ({ tokenHash: session.tokenHash, userId: session.userId, csrfToken: session.csrfToken, createdAt: session.createdAt, expiresAt: session.expiresAt })),
  };
}

/** One Node process owns the auth file; all account/session mutations are serialized. */
export class AuthStore {
  private writes: Promise<void> = Promise.resolve();
  private readonly registrationDigest: Buffer | null;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  // Unknown accounts still do the same scrypt work, using a process-local dummy record.
  private readonly dummyPassword: PasswordHash = {
    version: 1, algorithm: 'scrypt', ...PARAMETERS,
    salt: randomBytes(32).toString('hex'), key: randomBytes(HASH_BYTES).toString('hex'),
  };

  private constructor(readonly filePath: string, private state: AuthState, options: AuthOptions) {
    if (options.registrationSecret !== undefined && (typeof options.registrationSecret !== 'string'
      || options.registrationSecret.length < 32 || options.registrationSecret.length > 4_096)) {
      throw new Error('REGISTRATION_SECRET must contain between 32 and 4096 characters.');
    }
    this.registrationDigest = options.registrationSecret === undefined ? null : digest(options.registrationSecret);
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs <= 0 || this.sessionTtlMs > 30 * 24 * 60 * 60 * 1_000) {
      throw new Error('Session lifetime must be between 1 millisecond and 30 days.');
    }
    this.now = options.now ?? Date.now;
  }

  static async open(filePath: string, options: AuthOptions = {}): Promise<AuthStore> {
    let state: AuthState = { version: 1, users: [], sessions: [] };
    try {
      state = parseState(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const store = new AuthStore(path.resolve(filePath), state, options);
    await store.mutate(() => {});
    return store;
  }

  get registrationEnabled(): boolean {
    return this.registrationDigest !== null;
  }

  get firstUserId(): string | undefined {
    return this.state.users[0]?.id;
  }

  async register(usernameInput: unknown, passwordInput: unknown, secretInput: unknown): Promise<CreatedSession> {
    // Hashing avoids leaking secret lengths through the comparison itself.
    const suppliedDigest = digest(typeof secretInput === 'string' && secretInput.length <= 4_096 ? secretInput : '');
    if (!this.registrationDigest || !timingSafeEqual(suppliedDigest, this.registrationDigest)) {
      throw new AuthError(403, 'Registration was not accepted. Check the registration secret.');
    }
    const username = canonicalUsername(usernameInput);
    if (!username) throw new AuthError(400, 'Username must be 3–32 ASCII letters, numbers, underscores, or hyphens.');
    if (!validPassword(passwordInput)) throw new AuthError(400, 'Password must contain between 12 and 256 characters.');
    if (this.state.users.some(user => user.username === username)) throw new AuthError(409, 'That username is already registered.');
    const password = await hashPassword(passwordInput);
    return this.mutate(state => {
      if (state.users.some(user => user.username === username)) throw new AuthError(409, 'That username is already registered.');
      const user: StoredUser = { id: randomUUID(), username, createdAt: new Date(this.now()).toISOString(), password };
      state.users.push(user);
      return this.createSession(state, user);
    });
  }

  async login(usernameInput: unknown, passwordInput: unknown): Promise<CreatedSession> {
    const username = canonicalUsername(usernameInput);
    const user = username ? this.state.users.find(candidate => candidate.username === username) : undefined;
    const acceptablePassword = validPassword(passwordInput);
    const verified = await verifyPassword(acceptablePassword ? passwordInput : 'invalid-password', user?.password ?? this.dummyPassword);
    if (!user || !acceptablePassword || !verified) throw new AuthError(401, 'Username or password is incorrect.');
    return this.mutate(state => {
      const current = state.users.find(candidate => candidate.id === user.id);
      if (!current || !passwordMatches(current.password, user.password)) throw new AuthError(401, 'Username or password is incorrect.');
      return this.createSession(state, current);
    });
  }

  async getSession(rawToken: unknown): Promise<AuthSession | null> {
    if (typeof rawToken !== 'string' || !SESSION_TOKEN.test(rawToken)) return null;
    const tokenHash = digest(rawToken).toString('hex');
    const session = this.state.sessions.find(candidate => candidate.tokenHash === tokenHash);
    if (!session || session.expiresAt <= this.now()) return null;
    const user = this.state.users.find(candidate => candidate.id === session.userId);
    return user ? { user: publicUser(user), csrfToken: session.csrfToken, expiresAt: session.expiresAt } : null;
  }

  async logout(rawToken: unknown): Promise<void> {
    if (typeof rawToken !== 'string' || !SESSION_TOKEN.test(rawToken)) return;
    const tokenHash = digest(rawToken).toString('hex');
    await this.mutate(state => { state.sessions = state.sessions.filter(session => session.tokenHash !== tokenHash); });
  }

  /** A successful password change signs out every browser session for the user. */
  async changePassword(userId: string, currentPassword: unknown, newPassword: unknown): Promise<void> {
    const user = this.state.users.find(candidate => candidate.id === userId);
    const verified = await verifyPassword(validPassword(currentPassword) ? currentPassword : 'invalid-password', user?.password ?? this.dummyPassword);
    if (!user || !validPassword(currentPassword) || !verified) throw new AuthError(401, 'Current password is incorrect.');
    if (!validPassword(newPassword)) throw new AuthError(400, 'Password must contain between 12 and 256 characters.');
    const password = await hashPassword(newPassword);
    await this.mutate(state => {
      const current = state.users.find(candidate => candidate.id === userId);
      if (!current || !passwordMatches(current.password, user.password)) throw new AuthError(401, 'Current password is incorrect.');
      current.password = password;
      state.sessions = state.sessions.filter(session => session.userId !== userId);
    });
  }

  private createSession(state: AuthState, user: StoredUser): CreatedSession {
    const token = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const session: StoredSession = { tokenHash: digest(token).toString('hex'), userId: user.id, csrfToken: randomBytes(32).toString('hex'), createdAt, expiresAt: createdAt + this.sessionTtlMs };
    // Retain the newest nine before adding the new session.
    const prior = state.sessions.filter(candidate => candidate.userId === user.id);
    const remove = new Set(prior.slice(0, Math.max(0, prior.length - MAX_SESSIONS + 1)).map(candidate => candidate.tokenHash));
    state.sessions = state.sessions.filter(candidate => !remove.has(candidate.tokenHash));
    state.sessions.push(session);
    return { token, user: publicUser(user), csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  }

  private mutate<T>(operation: (state: AuthState) => T): Promise<T> {
    const result = this.writes.catch(() => {}).then(async () => {
      const next = structuredClone(this.state);
      next.sessions = next.sessions.filter(session => session.expiresAt > this.now());
      const value = operation(next);
      const directory = path.dirname(this.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const temporary = `${this.filePath}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await chmod(temporary, 0o600);
        await rename(temporary, this.filePath);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      this.state = next;
      return value;
    });
    this.writes = result.then(() => {});
    // Keep failed writes observable to callers without poisoning subsequent mutations.
    void this.writes.catch(() => {});
    return result;
  }
}
