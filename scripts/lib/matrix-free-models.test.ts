// @effect-diagnostics nodeBuiltinImport:off - Tests exercise launcher filesystem bootstrap.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  initializeMatrixFreeModels,
  matrixFreeModelSettings,
  resolveMatrixLaunchHome,
} from "./matrix-free-models.ts";

const GLM = "opencode/glm-5.3-flash-free";
const DEEPSEEK = "opencode/deepseek-v4.1-flash-free";
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "matrix-free-models-"));
  temporaryDirectories.push(directory);
  return directory;
}

function selection(model: string) {
  return { instanceId: "opencode", model };
}

describe("Matrix free model preset", () => {
  it("fills sparse settings without discarding unrelated preferences", () => {
    const settings = matrixFreeModelSettings({ projectSettingsFolded: true }, "/matrix");
    expect(settings).toMatchObject({
      projectSettingsFolded: true,
      defaultModelSelection: selection(GLM),
      textGenerationModelSelection: selection(GLM),
      providerInstances: {
        codex: { driver: "codex", enabled: false },
        claudeAgent: { driver: "claudeAgent", enabled: false },
        opencode: {
          enabled: true,
          config: {
            enabled: true,
            allowedModels: [GLM, DEEPSEEK],
            customModels: [
              { slug: GLM, name: "GLM 5.3 Flash (Free)" },
              { slug: DEEPSEEK, name: "DeepSeek V4.1 Flash (Free)" },
            ],
          },
        },
      },
    });
    expect(matrixFreeModelSettings(settings, "/matrix")).toEqual(settings);
  });

  it("keeps explicit free selections, names, binary preferences and opt-outs", () => {
    const settings = matrixFreeModelSettings(
      {
        defaultModelSelection: selection(DEEPSEEK),
        textGenerationModelSelection: selection(DEEPSEEK),
        providerInstances: {
          opencode: {
            driver: "opencode",
            enabled: false,
            displayName: "My free models",
            config: {
              binaryPath: "/tools/opencode",
              customModels: [{ slug: DEEPSEEK, name: "DeepSeek" }],
            },
            environment: [{ name: "HTTPS_PROXY", value: "http://proxy.test" }],
          },
        },
      },
      "/matrix",
    );
    expect(settings).toMatchObject({
      defaultModelSelection: selection(DEEPSEEK),
      textGenerationModelSelection: selection(DEEPSEEK),
      providerInstances: {
        opencode: {
          enabled: false,
          displayName: "My free models",
          config: { enabled: false, binaryPath: "/tools/opencode" },
          environment: expect.arrayContaining([
            { name: "HTTPS_PROXY", value: "http://proxy.test", sensitive: false },
          ]),
        },
      },
    });
  });

  it("removes paid routes and project re-enables while isolating credential overrides", () => {
    const settings = matrixFreeModelSettings(
      {
        defaultModelSelection: null,
        textGenerationModelSelection: { instanceId: "codex", model: "gpt-6-luna" },
        sourceControlWriterModelSelection: { instanceId: "personal", model: "paid" },
        providerInstances: {
          personal: { driver: "claudeAgent", enabled: true },
          opencode: {
            driver: "opencode",
            environment: [{ name: "XDG_DATA_HOME", value: "/personal" }],
            config: { serverUrl: "http://personal.test", customModels: ["opencode/paid"] },
          },
        },
        projectSettingsOverrides: {
          project1: {
            defaultModelSelection: { instanceId: "personal", model: "paid" },
            providerInstances: { codex: { enabled: true }, personal: { enabled: true } },
          },
        },
      },
      "/matrix",
    );
    expect(settings).toMatchObject({
      defaultModelSelection: selection(GLM),
      textGenerationModelSelection: selection(GLM),
      sourceControlWriterModelSelection: selection(GLM),
      providerInstances: {
        personal: { enabled: false },
        opencode: {
          config: { serverUrl: "", allowedModels: [GLM, DEEPSEEK] },
          environment: expect.arrayContaining([
            { name: "XDG_DATA_HOME", value: "/matrix/opencode/data" },
            { name: "OPENCODE_AUTH_CONTENT", value: "{}" },
          ]),
        },
      },
      projectSettingsOverrides: {
        project1: {
          defaultModelSelection: selection(GLM),
          providerInstances: { codex: { enabled: false }, personal: { enabled: false } },
        },
      },
    });
  });

  it("rejects invalid settings and conflicting reserved instance identities", () => {
    for (const invalid of [
      null,
      [],
      { projectSettingsFolded: "yes" },
      { providerInstances: { opencode: { driver: "codex" } } },
      { providerInstances: { opencode: { driver: "opencode", config: { binaryPath: 3 } } } },
    ]) {
      expect(() => matrixFreeModelSettings(invalid, "/matrix")).toThrow();
    }
  });

  it("fails closed without overwriting invalid persisted settings", async () => {
    const home = temporaryHome();
    await initializeMatrixFreeModels(home);
    const settingsPath = NodePath.join(home, "userdata", "settings.json");
    NodeFS.writeFileSync(settingsPath, "{broken");
    await expect(initializeMatrixFreeModels(home)).rejects.toThrow("refusing to launch");
    expect(NodeFS.readFileSync(settingsPath, "utf8")).toBe("{broken");
  });
});

describe("Matrix selected home", () => {
  it("consumes either explicit flag spelling before forwarding remaining options", () => {
    expect(resolveMatrixLaunchHome(["--share", "--home-dir", "/selected"], "/ambient")).toEqual({
      homeDir: "/selected",
      args: ["--share"],
    });
    expect(resolveMatrixLaunchHome(["--home-dir=/selected", "--browser"], "/ambient")).toEqual({
      homeDir: "/selected",
      args: ["--browser"],
    });
    expect(resolveMatrixLaunchHome([], "/ambient")).toEqual({ homeDir: "/ambient", args: [] });
  });

  it("rejects missing, blank, and ambiguous home overrides", () => {
    for (const args of [
      ["--home-dir"],
      ["--home-dir", "--share"],
      ["--home-dir="],
      ["--home-dir", " "],
      ["--home-dir=/one", "--home-dir=/two"],
    ]) {
      expect(() => resolveMatrixLaunchHome(args, "/ambient")).toThrow();
    }
    expect(() => resolveMatrixLaunchHome([], "")).toThrow();
  });
});
