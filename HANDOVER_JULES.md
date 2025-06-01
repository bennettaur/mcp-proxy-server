# Jules Handover Document

## Issue Statement

The core task is to refactor the `src` folder of an MCP proxy aggregator project for better organization and testability. The project aggregates multiple MCP proxies and tools into a single interface.

## Current Plan and Progress

The plan involves several steps to reorganize the codebase into services and a core logic layer.

**Completed Plan Steps:**

1.  **Create a `core` directory within `src` for refactored services.**
    *   Status: Completed. `src/core` created.
2.  **Refactor `config.ts` into `src/core/ConfigService.ts`.**
    *   Status: Completed. File moved and renamed.
3.  **Refactor `client.ts` into `src/core/ClientFactory.ts`.**
    *   Status: Completed. File moved, renamed, and main function `createClients` renamed to `createMcpClients`.
4.  **Create `src/core/ProxyService.ts` and move core proxy logic from `mcp-proxy.ts`.**
    *   Status: Completed. `ProxyService.ts` created and populated with core logic, state, MCP server instance, and request handlers.
5.  **Refactor `mcp-proxy.ts` to be a thin wrapper that uses `ProxyService.ts`.**
    *   Status: Completed. `mcp-proxy.ts` now instantiates `ProxyService` and delegates to it.
6.  **Create `src/services/HttpService.ts` and move Express/SSE/HTTP logic from `sse.ts`.**
    *   Status: Completed. `HttpService.ts` created with Express/HTTP setup, non-admin/non-terminal endpoints, and authentication.
7.  **Create `src/services/AdminService.ts` and move admin UI backend logic from `sse.ts`.**
    *   Status: Completed. `AdminService.ts` created with admin routes, session management, config file interactions, and tool installation logic.
8.  **Refactor `terminal.ts` into `src/services/TerminalService.ts`.**
    *   Status: Completed. `TerminalService.ts` created, encapsulating PTY management and routes.
9.  **Update `sse.ts` to orchestrate `HttpService`, `AdminService`, and `TerminalService`.**
    *   Status: Completed. `sse.ts` now instantiates and wires these services. `mcp-proxy.ts` was also updated for `ProxyService` instantiation.
10. **Update `index.ts` (Stdio server entry point).**
    *   Status: Completed. `index.ts` now correctly uses the refactored `ProxyService`.

**Current Blocker and Next Steps:**

The project is currently blocked by a critical build issue.

11. **Investigate `@modelcontextprotocol/sdk` structure in `node_modules`.** (Current active step, but blocked)
    *   **Problem:** Persistent "Cannot find module" errors for `@modelcontextprotocol/sdk` (specifically for paths like `...@sdk/types/index.js` or `...@sdk/types`) during `npm run build`. This prevents any further progress.
    *   **Critical Prerequisite:** The user has indicated that **Node.js v22.0.0 or higher is required**. Multiple attempts to verify and use this version have failed, with the environment consistently reporting Node.js v18.19.1. This version mismatch is the most likely cause of the SDK installation and module resolution failures.
    *   **Last Action:** The last interaction involved the user stating they would restart the task in a new environment with the correct Node.js version.

12. **Fix Build Errors Related to `@modelcontextprotocol/sdk` based on investigation.** (Blocked by step 11 and Node.js version)
    *   Once the Node.js version is correct and `npm install` can successfully fetch the SDK, this step involves:
        *   Correcting import paths for the SDK in files like `ProxyService.ts`, `HttpService.ts`, `ClientFactory.ts`.
        *   Ensuring schema objects (for runtime validation) and classes are imported as values (e.g., `import { Schema } ...`), and TypeScript interfaces/types are imported as types (e.g., `import type { Interface } ...`).
        *   The goal is to achieve a successful `npm run build`.

**Remaining Plan Steps (Post-Build Fix):**

13. **Add basic unit tests for the new services.**
    *   This was attempted but blocked by the build errors. The plan was to use Jest.
14. **Review and update all imports and paths.**
    *   A final check once everything is building and tests are in place.
15. **Submit the change.**

## Details for Next Instance of Jules

1.  **Node.js Version:** **Crucially, ensure the new environment is running Node.js v22.0.0 or higher.** This is paramount. Verify with `node --version` as the very first step.
2.  **Clean Install:** Once Node.js v22+ is confirmed, perform a clean install:
    *   `rm -f package-lock.json yarn.lock`
    *   `rm -rf node_modules`
    *   `npm install`
    *   Carefully examine the output of `npm install` for any errors, especially related to `@modelcontextprotocol/sdk`.
3.  **Verify SDK Installation (if `npm install` is clean):**
    *   Attempt to list the SDK's directory structure:
        *   `ls node_modules/@modelcontextprotocol/sdk`
        *   `ls node_modules/@modelcontextprotocol/sdk/dist`
        *   `ls node_modules/@modelcontextprotocol/sdk/lib`
        *   `ls node_modules/@modelcontextprotocol/sdk/types`
        *   If these commands show files/folders, it's a good sign.
4.  **Fix Build (`npm run build`):**
    *   With the correct Node.js version and (hopefully) a successful SDK installation, proceed to fix the TypeScript import errors as detailed in step 12 of the plan. The key is to correctly distinguish between value imports (for classes, schema objects) and type-only imports. The paths derived from the `ls` commands (if successful) will be vital here.
5.  **Continue with Plan:** Once `npm run build` is successful, proceed to add unit tests (step 13), review imports (step 14), and finally submit (step 15).

**Key Files Modified So Far (should be in the current git state):**

*   `src/core/ConfigService.ts` (from `src/config.ts`)
*   `src/core/ClientFactory.ts` (from `src/client.ts`)
*   `src/core/ProxyService.ts` (new, with logic from `src/mcp-proxy.ts`)
*   `src/mcp-proxy.ts` (refactored)
*   `src/services/HttpService.ts` (new, with logic from `src/sse.ts`)
*   `src/services/AdminService.ts` (new, with logic from `src/sse.ts`)
*   `src/services/TerminalService.ts` (from `src/terminal.ts`)
*   `src/sse.ts` (refactored as orchestrator)
*   `src/index.ts` (updated for new ProxyService usage)
*   Potentially `package.json` if Jest dependencies were added in a previous attempt (though the install failed).

Good luck to the next instance of Jules!
```
