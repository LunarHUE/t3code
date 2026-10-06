import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { hasCloudPublicConfig } from "./publicConfig.ts";
afterEach(() => vi.unstubAllEnvs());
describe("cloud public configuration", () => {
  it("requires only a secure relay origin", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(false);
  });
});
