import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config.js";

export interface AuthUser {
  id: number;
  email: string;
  role: "member" | "admin";
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

const ACCESS_TOKEN_TTL = "15m";

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ sub: String(user.id), email: user.email, role: user.role }, env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
    algorithm: "HS256",
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    req.user = {
      id: Number(payload.sub),
      email: String(payload.email),
      role: payload.role === "admin" ? "admin" : "member",
    };
    return next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "forbidden" });
  return next();
}
