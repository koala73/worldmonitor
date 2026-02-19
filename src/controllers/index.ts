/**
 * Controllers barrel export
 *
 * Each controller encapsulates a cohesive group of methods extracted from the
 * monolithic App class.  App.ts acts as a thin composition root that
 * instantiates these controllers and wires their callbacks together.
 */

export type { AppContext, CountryBriefSignals, IntelligenceCache } from './app-context';
export { RefreshScheduler } from './refresh-scheduler';
export type { RefreshCallbacks } from './refresh-scheduler';
export { DeepLinkHandler } from './deep-link-handler';
export type { DeepLinkCallbacks } from './deep-link-handler';
export { DesktopUpdater } from './desktop-updater';
export { CountryIntelController } from './country-intel';
export type { CountryIntelDeps } from './country-intel';
export { UISetupController } from './ui-setup';
export type { UICallbacks } from './ui-setup';
export { DataLoaderController } from './data-loader';
export type { DataLoaderCallbacks } from './data-loader';
export { PanelManager } from './panel-manager';
export type { PanelManagerCallbacks } from './panel-manager';
