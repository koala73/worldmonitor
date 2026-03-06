/**
 * World Monitor Agent — Entry Point
 * AI Chat interface inspired by Qwen/Doubao UI design.
 */

import { AgentApp } from './agent-app';

const root = document.getElementById('agent-root');
if (root) {
  const app = new AgentApp(root);
  app.init();
}
