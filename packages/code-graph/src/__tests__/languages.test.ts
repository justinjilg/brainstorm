import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerAdapter,
  getAdapterForExtension,
  initializeAdapters,
} from "../languages/registry.js";
import { createTypeScriptAdapter } from "../languages/typescript.js";
import { createPythonAdapter } from "../languages/python.js";
import { createGoAdapter } from "../languages/go.js";
import { createRustAdapter } from "../languages/rust.js";
import { createJavaAdapter } from "../languages/java.js";
import type { ParsedFile } from "../parser.js";

function tmpFile(ext: string, content: string): string {
  const dir = join(
    tmpdir(),
    `lang-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `test${ext}`);
  writeFileSync(path, content, "utf-8");
  return path;
}

function parseWithAdapter(ext: string, content: string): ParsedFile {
  const path = tmpFile(ext, content);
  const adapter = getAdapterForExtension(ext)!;
  expect(adapter).not.toBeNull();
  const tree = adapter.getParser(ext).parse(content);
  return adapter.extractNodes(tree, path, content);
}

describe("TypeScript adapter", () => {
  beforeAll(() => {
    registerAdapter(createTypeScriptAdapter());
  });

  it("extracts functions, classes, methods, calls, imports", () => {
    const result = parseWithAdapter(
      ".ts",
      `
import { Router } from "express";

export function handleAuth(req: Request): boolean {
  return validateToken(req.headers.authorization);
}

function validateToken(token: string): boolean {
  return token.startsWith("Bearer ");
}

export class AuthService {
  static getInstance(): AuthService {
    return new AuthService();
  }

  async verify(token: string): Promise<boolean> {
    return validateToken(token);
  }
}
`,
    );

    expect(result.language).toBe("typescript");
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
    expect(
      result.functions.find((f) => f.name === "handleAuth")?.isExported,
    ).toBe(true);
    expect(
      result.functions.find((f) => f.name === "validateToken")?.isExported,
    ).toBe(false);
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].name).toBe("AuthService");
    expect(result.methods.length).toBeGreaterThanOrEqual(2);
    expect(result.methods.find((m) => m.name === "verify")?.isAsync).toBe(true);
    expect(result.methods.find((m) => m.name === "getInstance")?.isStatic).toBe(
      true,
    );
    expect(
      result.callSites.find((c) => c.calleeName === "validateToken"),
    ).toBeTruthy();
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].source).toBe("express");
  });

  it("handles generator functions", () => {
    const result = parseWithAdapter(
      ".ts",
      `
export function* runLoop() {
  yield processItem();
}
`,
    );
    expect(result.functions.find((f) => f.name === "runLoop")).toBeTruthy();
    expect(
      result.callSites.find((c) => c.calleeName === "processItem")?.callerName,
    ).toBe("runLoop");
  });
});

describe("Python adapter", () => {
  beforeAll(() => {
    registerAdapter(createPythonAdapter());
  });

  it("extracts functions, classes, methods, calls, imports", () => {
    const result = parseWithAdapter(
      ".py",
      `
from flask import Flask, request
import os

def handle_auth(req):
    return validate_token(req.headers.get("Authorization"))

def validate_token(token):
    return token.startswith("Bearer ")

class AuthService:
    @staticmethod
    def get_instance():
        return AuthService()

    async def verify(self, token):
        return validate_token(token)
`,
    );

    expect(result.language).toBe("python");
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
    expect(result.functions.find((f) => f.name === "handle_auth")).toBeTruthy();
    expect(
      result.functions.find((f) => f.name === "validate_token"),
    ).toBeTruthy();
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].name).toBe("AuthService");
    expect(result.methods.length).toBeGreaterThanOrEqual(2);
    expect(
      result.callSites.find((c) => c.calleeName === "validate_token"),
    ).toBeTruthy();
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
    expect(result.imports.find((i) => i.source === "flask")).toBeTruthy();
  });
});

describe("Go adapter", () => {
  beforeAll(() => {
    registerAdapter(createGoAdapter());
  });

  it("extracts functions, methods, structs, calls, imports", () => {
    const result = parseWithAdapter(
      ".go",
      `
package auth

import (
    "fmt"
    "net/http"
)

type AuthService struct {
    secret string
}

func NewAuthService(secret string) *AuthService {
    return &AuthService{secret: secret}
}

func (s *AuthService) Validate(token string) bool {
    fmt.Println("validating")
    return checkSignature(token, s.secret)
}

func checkSignature(token string, secret string) bool {
    return len(token) > 0
}
`,
    );

    expect(result.language).toBe("go");
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
    expect(
      result.functions.find((f) => f.name === "NewAuthService")?.isExported,
    ).toBe(true);
    expect(
      result.functions.find((f) => f.name === "checkSignature")?.isExported,
    ).toBe(false);
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].name).toBe("AuthService");
    expect(result.methods).toHaveLength(1);
    expect(result.methods[0].name).toBe("Validate");
    expect(result.methods[0].className).toBe("AuthService");
    expect(
      result.callSites.find((c) => c.calleeName === "checkSignature"),
    ).toBeTruthy();
    expect(
      result.callSites.find((c) => c.calleeName === "Println"),
    ).toBeTruthy();
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Rust adapter", () => {
  beforeAll(() => {
    registerAdapter(createRustAdapter());
  });

  it("extracts functions, impl methods, structs, calls, imports", () => {
    const result = parseWithAdapter(
      ".rs",
      `
use std::collections::HashMap;

pub struct TokenValidator {
    secret: String,
}

impl TokenValidator {
    pub fn new(secret: String) -> Self {
        Self { secret }
    }

    pub fn validate(&self, token: &str) -> bool {
        check_signature(token, &self.secret)
    }
}

fn check_signature(token: &str, secret: &str) -> bool {
    token.len() > 0
}

pub async fn handle_request(req: Request) -> Response {
    let validator = TokenValidator::new("secret".to_string());
    validator.validate(&req.token)
}
`,
    );

    expect(result.language).toBe("rust");
    expect(result.functions.length).toBeGreaterThanOrEqual(2);
    const handleReq = result.functions.find((f) => f.name === "handle_request");
    expect(handleReq).toBeTruthy();
    expect(handleReq?.isAsync).toBe(true);
    expect(result.classes.length).toBeGreaterThanOrEqual(1); // struct + impl
    expect(
      result.classes.find((c) => c.name === "TokenValidator"),
    ).toBeTruthy();
    expect(result.methods.length).toBeGreaterThanOrEqual(2);
    expect(result.methods.find((m) => m.name === "validate")?.className).toBe(
      "TokenValidator",
    );
    expect(
      result.callSites.find((c) => c.calleeName === "check_signature"),
    ).toBeTruthy();
    expect(result.imports.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Java adapter", () => {
  beforeAll(() => {
    registerAdapter(createJavaAdapter());
  });

  it("extracts classes, methods, calls, imports", () => {
    const result = parseWithAdapter(
      ".java",
      `
package com.example.auth;

import java.util.HashMap;
import com.example.crypto.SignatureVerifier;

public class AuthService {
    private final String secret;

    public AuthService(String secret) {
        this.secret = secret;
    }

    public boolean validate(String token) {
        SignatureVerifier verifier = new SignatureVerifier();
        return verifier.check(token, this.secret);
    }

    private static boolean isExpired(String token) {
        return token.isEmpty();
    }
}
`,
    );

    expect(result.language).toBe("java");
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].name).toBe("AuthService");
    expect(result.classes[0].isExported).toBe(true);
    expect(result.methods.length).toBeGreaterThanOrEqual(3); // constructor + validate + isExpired
    expect(result.methods.find((m) => m.name === "validate")).toBeTruthy();
    expect(result.methods.find((m) => m.name === "isExpired")?.isStatic).toBe(
      true,
    );
    expect(result.callSites.find((c) => c.calleeName === "check")).toBeTruthy();
    expect(
      result.callSites.find((c) => c.calleeName === "new SignatureVerifier"),
    ).toBeTruthy();
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
  });
});

describe("initializeAdapters", () => {
  it("loads all available adapters", async () => {
    const loaded = await initializeAdapters();
    expect(loaded).toContain("typescript");
    expect(loaded).toContain("python");
    expect(loaded).toContain("go");
    expect(loaded).toContain("rust");
    expect(loaded).toContain("java");
    expect(loaded.length).toBe(5);
  });
});
