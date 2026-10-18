import type { Page } from '@playwright/test';

// Chrome 155 changed native `ModelContext.executeTool(tool, input, options)`
// to take `input` as a plain object, matching the WebMCP draft. A JSON string
// is now rejected before the tool runs:
//   TypeError: Failed to execute 'executeTool' on 'ModelContext':
//   invalid input object: value is not an object
// Chrome 154 and earlier accept only the JSON string, and reject an object
// with `UnknownError: Failed to parse input arguments`, also before the tool
// runs. GitHub's ubuntu-24.04 image moved from Chrome 154 to 155 in
// 20261012.334, and image rollouts are gradual, so the strict smoke must pass
// on both milestones.
//
// This follows Chrome's own guidance: send the object, and fall back to the
// JSON string only on the pre-155 parse rejection. Neither rejection enters
// the tool callback, so the fallback never executes a tool twice. Every other
// error, including a caller-side abort, is rethrown unchanged.
type WebMcpExecutor = {
  executeTool(
    tool: unknown,
    input: Record<string, unknown> | string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
};

export type ExecuteWebMcpTool = (
  provider: WebMcpExecutor,
  tool: unknown,
  input: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

declare global {
  interface Window {
    __wmExecuteWebMcpTool: ExecuteWebMcpTool;
  }
}

export async function installWebMcpExecuteTool(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const execute: ExecuteWebMcpTool = async (provider, tool, input, options) => {
      try {
        return await provider.executeTool(tool, input, options);
      } catch (error) {
        const message = error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : '';
        if (!message.startsWith('Failed to parse input')) throw error;
        return provider.executeTool(tool, JSON.stringify(input), options);
      }
    };
    Object.defineProperty(window, '__wmExecuteWebMcpTool', {
      configurable: true,
      value: execute,
    });
  });
}
