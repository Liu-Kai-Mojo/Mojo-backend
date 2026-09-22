import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { Role } from "@prisma/client";
import bcrypt from "bcryptjs";

import { prisma } from "./prisma.js";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();

  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set and contain at least 32 characters.");
  }

  return secret;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function issueToken(user: {
  id: string;
  role: Role;
  name?: string;
  identifier?: string;
  identifierType?: unknown;
}): string {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
    },
    getJwtSecret(),
    {
      expiresIn: "8h",
    }
  );
}

export function auth(roles?: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization || "";

      if (!header.startsWith("Bearer ")) {
        return res.status(401).json({
          error: "Authentication is required.",
        });
      }

      const raw = header.slice(7).trim();

      if (!raw) {
        return res.status(401).json({
          error: "Authentication is required.",
        });
      }

      const payload = jwt.verify(raw, getJwtSecret());

      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof payload.sub !== "string" ||
        typeof payload.role !== "string"
      ) {
        return res.status(401).json({
          error: "The authentication token is invalid.",
        });
      }

      if (!Object.values(Role).includes(payload.role as Role)) {
        return res.status(401).json({
          error: "The authentication token is invalid.",
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, active: true },
      });

      if (!user || !user.active) {
        return res.status(401).json({
          error: "The account is inactive or no longer available.",
        });
      }

      // Authorize using the current database role so role changes take effect immediately.
      const role = user.role;

      if (roles?.length && !roles.includes(role)) {
        return res.status(403).json({
          error: "You do not have permission to access this resource.",
        });
      }

      res.locals.auth = {
        sub: user.id,
        role,
      };

      return next();
    } catch {
      return res.status(401).json({
        error: "The authentication token is invalid or expired.",
      });
    }
  };
}