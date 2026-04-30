import { describe, expect, it, vi } from "vitest";

import registerExtension from "./index.js";

describe("context-comments extension", () => {
  it("registers command, shortcuts, and lifecycle hooks", () => {
    const pi = {
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      appendEntry: vi.fn(),
    };

    registerExtension(pi as never);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "context-comments",
      expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
    );
    expect(pi.registerShortcut).toHaveBeenCalledTimes(2);
    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
  });
});
