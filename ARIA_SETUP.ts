/**
 * ARIA Panel Registration
 * 
 * Add this to src/config/panels.ts in the PANELS array:
 */

export const ariaPanelConfig = {
  name: "aria",
  label: "ARIA Intelligence",
  description:
    "JARVIS-like AI assistant - intelligent analysis of global events, markets, and risks",
  componentName: "AriaPanel",
  defaultWidth: 4,
  defaultHeight: 5,
  minWidth: 2,
  minHeight: 3,
  icon: "🤖",
  category: "intelligence",
  premium: false,
  supportedVariants: ["full", "tech"],
  refreshInterval: 30000,
  dataLoadPriority: "medium",
  allowResize: true,
  allowMove: true,
  allowRemove: true,
  autoHide: false,
  hidden: false,
  description:
    "Advanced Real-time Intelligence Assistant for global awareness and analysis",
  capabilities: [
    "Multi-domain intelligence aggregation",
    "Streaming AI analysis",
    "Smart widget suggestions",
    "Reasoning transparency",
    "Real-time context awareness",
  ],
  keywords: [
    "ai",
    "assistant",
    "analysis",
    "jarvis",
    "intelligence",
    "global",
    "markets",
    "military",
    "climate",
    "cyber",
  ],
};

/**
 * Add this to src/config/variants/full.ts:
 */

export const ariaPanelInVariant = {
  defaultPanels: [
    // ... existing panels
    "aria", // ARIA Intelligence Panel
  ],
  panelOverrides: {
    aria: {
      defaultWidth: 4,
      defaultHeight: 5,
      defaultX: 0,
      defaultY: 0,
      visible: true,
    },
  },
};

/**
 * Add this to src/app/data-loader.ts in loadAppData():
 */

export const ariaDataLoaderExample = `
  // Load ARIA awareness state
  const ariaAwarenessPromise = ctx.enableAria
    ? getCachedAwarenessState().catch((error) => {
        console.warn("Failed to load ARIA awareness:", error);
        return null;
      })
    : null;

  // In parallel loads section:
  const [
    ...otherData,
    ariaAwareness,
  ] = await Promise.all([
    ...otherDataPromises,
    ariaAwarenessPromise,
  ]);

  // Store in context
  ctx.ariaAwareness = ariaAwareness;
`;

/**
 * Add this to src/app/app-context.ts in AppContext interface:
 */

export const ariaContextExample = `
  interface AppContext {
    // ... existing properties

    // ARIA Intelligence System
    ariaAwareness?: AwarenessState;
    enableAria?: boolean;
    ariaConversationId?: string;
    ariaMode?: "analytical" | "proactive" | "advisory" | "exploratory";
  }
`;

/**
 * Add this to src/App.ts in component imports:
 */

export const ariaComponentImportExample = `
  import { AriaPanel } from "./components/AriaPanel";
  
  // In component registry:
  const componentRegistry = {
    // ... existing components
    AriaPanel,
  };
`;

/**
 * Type definitions for ARIA configuration
 */
export interface AriaPanelConfig {
  name: string;
  label: string;
  description: string;
  componentName: string;
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
  icon: string;
  category: string;
  premium: boolean;
  supportedVariants: string[];
  refreshInterval: number;
  dataLoadPriority: "high" | "medium" | "low";
}

export interface AriaVariantConfig {
  defaultPanels: string[];
  panelOverrides: {
    [panelName: string]: {
      defaultWidth?: number;
      defaultHeight?: number;
      defaultX?: number;
      defaultY?: number;
      visible?: boolean;
    };
  };
}

/**
 * ARIA Integration Checklist
 * 
 * Complete these steps to fully integrate ARIA:
 * 
 * [ ] 1. Register ARIA Panel
 *      - Open src/config/panels.ts
 *      - Add ariaPanelConfig to PANELS array
 *      - Import AriaPanel component
 * 
 * [ ] 2. Add to Variants
 *      - Open src/config/variants/full.ts
 *      - Add 'aria' to defaultPanels array
 *      - Add panel overrides if needed
 * 
 * [ ] 3. Wire Data Loading
 *      - Open src/app/data-loader.ts
 *      - Import getCachedAwarenessState from services/aria
 *      - Add ARIA awareness loading to parallel loads
 *      - Store result in ctx.ariaAwareness
 * 
 * [ ] 4. Update App Context
 *      - Open src/app/app-context.ts
 *      - Add ariaAwareness, enableAria, ariaMode properties
 *      - Update AppContext interface
 * 
 * [ ] 5. Import Component
 *      - Open src/App.ts
 *      - Import AriaPanel from components
 *      - Add to component registry if needed
 * 
 * [ ] 6. Configure Environment
 *      - Set VITE_ENABLE_ARIA=true in .env
 *      - Configure LLM API key: VITE_LLM_API_KEY
 *      - Set data sources: VITE_DATA_SOURCES
 * 
 * [ ] 7. Test Integration
 *      - npm run dev
 *      - Navigate to dashboard
 *      - Add ARIA panel to layout
 *      - Ask ARIA a test question
 *      - Verify streaming response
 *      - Test suggested actions
 * 
 * [ ] 8. Optimize (Optional)
 *      - Add domain-specific system prompts
 *      - Create custom analysis modes
 *      - Add more suggested action rules
 *      - Configure cache tiers
 * 
 * Expected time to completion: 30-45 minutes
 */

/**
 * Troubleshooting Guide
 * 
 * Issue: ARIA panel not showing
 * Solution:
 * - Check that 'aria' is in defaultPanels array
 * - Verify AriaPanel component is imported
 * - Check browser console for errors
 * - Ensure panel name matches component registration
 * 
 * Issue: Queries not streaming
 * Solution:
 * - Verify /api/aria/query endpoint exists
 * - Check network tab for SSE connection
 * - Ensure API key is configured
 * - Check for CORS errors in console
 * 
 * Issue: Awareness state is null
 * Solution:
 * - Check Redis/cache connection
 * - Verify data sources are responding
 * - Review error logs in Edge Function
 * - Ensure circuit breakers aren't open
 * 
 * Issue: Suggested actions not showing
 * Solution:
 * - Check buildAriaActions() rules in handler
 * - Verify action keywords match query text
 * - Ensure widget names are registered
 * - Review browser console for JavaScript errors
 * 
 * Issue: Performance degradation
 * Solution:
 * - Check cache TTL settings
 * - Review data source latency
 * - Enable compression on responses
 * - Use CDN for static content
 * - Consider pagination for large datasets
 */
