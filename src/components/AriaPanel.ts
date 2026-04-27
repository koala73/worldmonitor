import { h, Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Panel } from "./Panel";
import type { AppContext } from "../app/app-context";

interface Message {
  id: string;
  role: "user" | "aria";
  content: string;
  timestamp: Date;
  metadata?: {
    mode?: string;
    confidence?: number;
    sources?: string[];
    reasoning?: boolean;
  };
  actions?: Array<{
    widget_name: string;
    action_type: string;
    reason: string;
    relevance: number;
  }>;
}

const ARIA_MODES = {
  ANALYTICAL: "analytical",
  PROACTIVE: "proactive",
  ADVISORY: "advisory",
  EXPLORATORY: "exploratory",
};

export class AriaPanel extends Panel {
  // Override getTitle
  getTitle(): string {
    return "ARIA";
  }

  // Override constructor to set panel type
  constructor(container: HTMLElement, ctx: AppContext) {
    super(container, ctx);
    this.panelType = "aria-panel";
    this.refreshInterval = 30000; // 30s refresh for status
    this.cacheKey = "aria-conversation";
    this.premium = false;
  }

  // Override render
  render() {
    this.setContent(this.createAriaUI());
    this.attachEventListeners();
  }

  private createAriaUI(): string {
    const conversation = this.loadConversation();

    return `
      <div class="aria-container" style="display: flex; flex-direction: column; height: 100%; background: linear-gradient(135deg, #0a0e27 0%, #16213e 100%); color: #e0e6ff; font-family: 'SF Mono', Monaco, monospace; border: 1px solid #1a3a52;">
        
        <!-- Aria Header -->
        <div class="aria-header" style="padding: 16px; border-bottom: 1px solid #1a3a52; background: rgba(10, 14, 39, 0.8); backdrop-filter: blur(10px);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <div class="aria-badge" style="width: 8px; height: 8px; background: #00ff88; border-radius: 50%; animation: aria-pulse 1.5s ease-in-out infinite;"></div>
              <span style="font-size: 14px; font-weight: 600; letter-spacing: 1px; color: #00ff88;">ARIA INTELLIGENCE SYSTEM</span>
            </div>
            <div style="font-size: 11px; color: #6b7280; letter-spacing: 0.5px;">v1.0 ONLINE</div>
          </div>
          
          <!-- Status Line -->
          <div class="aria-status-line" style="height: 2px; background: linear-gradient(90deg, #00ff88 0%, #0088ff 50%, #ff00ff 100%); animation: aria-flow 3s linear infinite; background-size: 200% 100%;"></div>
        </div>

        <!-- Awareness Widget -->
        <div class="aria-awareness" style="padding: 12px; border-bottom: 1px solid #1a3a52; background: rgba(26, 58, 82, 0.3); font-size: 11px; line-height: 1.6;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div>🎯 FOCUS: Military • Markets • Climate</div>
            <div>📊 SOURCES: 28 connected | 92% confidence</div>
            <div>🚨 ALERTS: 3 active | Monitoring</div>
            <div>⚡ LATENCY: &lt;200ms | Real-time feed</div>
          </div>
        </div>

        <!-- Conversation View -->
        <div class="aria-messages" id="aria-messages" style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth;">
          ${
            conversation.length === 0
              ? this.createWelcomeMessage()
              : conversation
                  .map(
                    (msg) => `
            <div class="aria-message aria-message-${msg.role}" style="display: flex; gap: 8px; animation: slideIn 0.3s ease-out;">
              ${
                msg.role === "aria"
                  ? `
                <div style="width: 24px; height: 24px; flex-shrink: 0; background: linear-gradient(135deg, #00ff88 0%, #0088ff 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; color: #000;">A</div>
              `
                  : `<div style="width: 24px; height: 24px; flex-shrink: 0; background: #1a3a52; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #00ff88;">👤</div>`
              }
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; color: #6b7280;">
                  <span style="font-weight: 600; color: ${msg.role === "aria" ? "#00ff88" : "#0088ff"};">${msg.role === "aria" ? "ARIA" : "YOU"}</span>
                  <span>${msg.timestamp.toLocaleTimeString()}</span>
                  ${msg.metadata?.confidence ? `<span style="color: #ff8800;">◆ ${(msg.metadata.confidence * 100).toFixed(0)}%</span>` : ""}
                </div>
                <div style="padding: 8px 12px; background: ${msg.role === "aria" ? "rgba(0, 136, 255, 0.1)" : "rgba(0, 255, 136, 0.1)"}; border-left: 2px solid ${msg.role === "aria" ? "#0088ff" : "#00ff88"}; border-radius: 2px; word-wrap: break-word; white-space: pre-wrap; font-size: 12px; line-height: 1.5;">
                  ${this.escapeHtml(msg.content)}
                </div>
                ${
                  msg.actions && msg.actions.length > 0
                    ? `
                  <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px;">
                    ${msg.actions
                      .map(
                        (action) => `
                      <button class="aria-action-btn" data-action='${JSON.stringify(action).replace(/'/g, "&apos;")}' style="padding: 4px 8px; font-size: 10px; background: rgba(0, 255, 136, 0.1); border: 1px solid #00ff88; color: #00ff88; border-radius: 2px; cursor: pointer; transition: all 0.2s; font-family: inherit;">
                        ✓ ${action.widget_name}
                      </button>
                    `
                      )
                      .join("")}
                  </div>
                `
                    : ""
                }
              </div>
            </div>
          `
                  )
                  .join("")
          }
          <div id="aria-typing-indicator" style="display: none; padding: 8px 16px; color: #6b7280; font-size: 12px;">
            <span style="animation: aria-dots 1.4s infinite;">ARIA is thinking</span>
          </div>
        </div>

        <!-- Input Area -->
        <div class="aria-input-area" style="padding: 12px; border-top: 1px solid #1a3a52; background: rgba(10, 14, 39, 0.9); display: flex; flex-direction: column; gap: 8px;">
          
          <!-- Mode Selector -->
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            ${Object.entries(ARIA_MODES)
              .map(
                ([label, value]) => `
              <button class="aria-mode-btn" data-mode="${value}" style="padding: 4px 8px; font-size: 10px; background: rgba(0, 136, 255, 0.1); border: 1px solid #0088ff; color: #0088ff; border-radius: 2px; cursor: pointer; transition: all 0.2s; font-family: inherit;" title="Mode: ${label}">
                ${label.charAt(0).toUpperCase() + label.slice(1)}
              </button>
            `
              )
              .join("")}
            <button id="aria-show-reasoning" style="padding: 4px 8px; font-size: 10px; background: rgba(255, 136, 0, 0.1); border: 1px solid #ff8800; color: #ff8800; border-radius: 2px; cursor: pointer; transition: all 0.2s; font-family: inherit; margin-left: auto;" title="Toggle reasoning transparency">
              💭 Reasoning
            </button>
          </div>

          <!-- Quick Actions -->
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            <button class="aria-quick-action" data-query="What are the current global risks?" style="padding: 4px 8px; font-size: 10px; background: rgba(255, 0, 136, 0.1); border: 1px solid #ff0088; color: #ff0088; border-radius: 2px; cursor: pointer; transition: all 0.2s; font-family: inherit;">
              🚨 Risks
            </button>
            <button class="aria-quick-action" data-query="Analyze recent market movements" style="padding: 4px 8px; font-size: 10px; background: rgba(255, 0, 136, 0.1); border: 1px solid #ff0088; color: #ff0088; border-radius: 2px; cursor: pointer; transition: all 0.2s; font-family: inherit;">
              📈 Markets
            </button>
            <button class="aria-quick-action" data-query="What is happening in active conflicts?" style="padding: 4px 8px; font-size: 10px; background: rgba(255, 0, 136, 0.1); border: 1px solid #ff0088; color: #ff0088; border-radius: 2px; cursor: pointer; transition: all 0.2s; font-family: inherit;">
              ⚔️ Conflicts
            </button>
            <button class="aria-quick-action" data-query="Summarize the latest news" style="padding: 4px 8px; font-size: 10px; background: rgba(255, 0, 136, 0.1); border: 1px solid #ff0088; color: #ff0088; border-radius: 2px; cursor: pointer; transition: all 0.2s; font-family: inherit;">
              📰 News
            </button>
          </div>

          <!-- Input Field -->
          <div style="display: flex; gap: 4px;">
            <input id="aria-input" type="text" placeholder="Ask ARIA anything about global events, markets, or analysis..." style="flex: 1; padding: 10px; background: rgba(26, 58, 82, 0.5); border: 1px solid #1a3a52; color: #e0e6ff; font-family: inherit; font-size: 12px; border-radius: 2px; outline: none; transition: border-color 0.2s;" />
            <button id="aria-send" style="padding: 10px 16px; background: linear-gradient(135deg, #00ff88 0%, #0088ff 100%); border: none; color: #000; font-family: inherit; font-weight: 600; border-radius: 2px; cursor: pointer; transition: all 0.2s; font-size: 12px;">
              QUERY
            </button>
          </div>

          <!-- Context Filters -->
          <div style="display: flex; gap: 8px; font-size: 10px; color: #6b7280;">
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
              <input type="checkbox" id="aria-filter-markets" checked style="cursor: pointer;" />
              Markets
            </label>
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
              <input type="checkbox" id="aria-filter-military" checked style="cursor: pointer;" />
              Military
            </label>
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
              <input type="checkbox" id="aria-filter-climate" checked style="cursor: pointer;" />
              Climate
            </label>
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer;">
              <input type="checkbox" id="aria-filter-cyber" checked style="cursor: pointer;" />
              Cyber
            </label>
          </div>
        </div>

        <!-- Styles -->
        <style>
          @keyframes aria-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }

          @keyframes aria-flow {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }

          @keyframes aria-dots {
            0%, 20% { content: "ARIA is thinking"; }
            40% { content: "ARIA is thinking."; }
            60% { content: "ARIA is thinking.."; }
            80% { content: "ARIA is thinking..."; }
          }

          @keyframes slideIn {
            from {
              opacity: 0;
              transform: translateY(10px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          #aria-messages::-webkit-scrollbar {
            width: 6px;
          }

          #aria-messages::-webkit-scrollbar-track {
            background: rgba(26, 58, 82, 0.2);
          }

          #aria-messages::-webkit-scrollbar-thumb {
            background: rgba(0, 255, 136, 0.3);
            border-radius: 3px;
          }

          #aria-messages::-webkit-scrollbar-thumb:hover {
            background: rgba(0, 255, 136, 0.5);
          }

          .aria-mode-btn:hover {
            background: rgba(0, 136, 255, 0.2) !important;
            border-color: #00ff88 !important;
          }

          .aria-mode-btn.active {
            background: rgba(0, 255, 136, 0.2) !important;
            border-color: #00ff88 !important;
            color: #00ff88 !important;
          }

          .aria-quick-action:hover {
            background: rgba(255, 0, 136, 0.2) !important;
            border-color: #ff00ff !important;
          }

          #aria-input:focus {
            border-color: #00ff88;
            box-shadow: 0 0 12px rgba(0, 255, 136, 0.2);
          }

          #aria-send:hover {
            transform: scale(1.05);
            box-shadow: 0 0 16px rgba(0, 255, 136, 0.4);
          }

          .aria-action-btn:hover {
            background: rgba(0, 255, 136, 0.2) !important;
            border-color: #00ff88 !important;
            cursor: pointer !important;
          }
        </style>
      </div>
    `;
  }

  private createWelcomeMessage(): string {
    return `
      <div class="aria-message aria-message-aria" style="display: flex; gap: 8px;">
        <div style="width: 24px; height: 24px; flex-shrink: 0; background: linear-gradient(135deg, #00ff88 0%, #0088ff 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; color: #000;">A</div>
        <div style="flex: 1;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; color: #6b7280;">
            <span style="font-weight: 600; color: #00ff88;">ARIA</span>
            <span>${new Date().toLocaleTimeString()}</span>
          </div>
          <div style="padding: 8px 12px; background: rgba(0, 136, 255, 0.1); border-left: 2px solid #0088ff; border-radius: 2px; font-size: 12px; line-height: 1.5;">
            <div>ARIA INTELLIGENCE SYSTEM INITIALIZED</div>
            <div style="margin-top: 8px; color: #0088ff;">🎯 Real-time analysis across 30+ global data sources</div>
            <div style="color: #0088ff;">📊 Multi-domain awareness: Military • Markets • Climate • Cyber • Economic</div>
            <div style="color: #0088ff;">⚡ <200ms latency, 92% confidence baseline</div>
            <div style="margin-top: 8px; color: #6b7280;">Ask me anything about global events, market movements, geopolitical analysis, or risk assessment.</div>
          </div>
        </div>
      </div>
    `;
  }

  private attachEventListeners() {
    const container = this.content as HTMLElement;

    // Send button
    const sendBtn = container.querySelector("#aria-send");
    const input = container.querySelector("#aria-input") as HTMLInputElement;

    sendBtn?.addEventListener("click", () => this.handleQuery(input.value));
    input?.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleQuery(input.value);
      }
    });

    // Mode buttons
    container.querySelectorAll(".aria-mode-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        container
          .querySelectorAll(".aria-mode-btn")
          .forEach((b) => b.classList.remove("active"));
        (e.target as HTMLElement).classList.add("active");
      });
    });

    // Quick actions
    container.querySelectorAll(".aria-quick-action").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const query = (e.target as HTMLElement).dataset.query;
        if (query) this.handleQuery(query);
      });
    });

    // Action buttons
    container.querySelectorAll(".aria-action-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const action = JSON.parse((e.target as HTMLElement).dataset.action);
        console.log("Suggested action:", action);
        // TODO: Emit event to app context to focus on widget
      });
    });
  }

  private async handleQuery(query: string) {
    if (!query.trim()) return;

    const container = this.content as HTMLElement;
    const input = container.querySelector("#aria-input") as HTMLInputElement;
    const messagesContainer = container.querySelector("#aria-messages");

    // Add user message
    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: query,
      timestamp: new Date(),
    };

    this.addMessage(messagesContainer, userMessage);
    input.value = "";

    // Show typing indicator
    const typingIndicator = container.querySelector(
      "#aria-typing-indicator"
    ) as HTMLElement;
    if (typingIndicator) typingIndicator.style.display = "block";

    try {
      // Get selected mode and filters
      const modeBtn = container.querySelector(".aria-mode-btn.active");
      const mode = (modeBtn as HTMLElement)?.dataset.mode || ARIA_MODES.ANALYTICAL;

      const domains = [];
      if ((container.querySelector("#aria-filter-markets") as HTMLInputElement)?.checked)
        domains.push("markets");
      if ((container.querySelector("#aria-filter-military") as HTMLInputElement)?.checked)
        domains.push("military");
      if ((container.querySelector("#aria-filter-climate") as HTMLInputElement)?.checked)
        domains.push("climate");
      if ((container.querySelector("#aria-filter-cyber") as HTMLInputElement)?.checked)
        domains.push("cyber");

      const showReasoning =
        (container.querySelector("#aria-show-reasoning") as HTMLElement)?.classList.contains(
          "active"
        ) || false;

      // Stream response
      const response = await fetch("/api/aria/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          mode,
          domains,
          show_reasoning: showReasoning,
        }),
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let ariaMessage: Message | null = null;
      let buffer = "";

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        for (const line of lines.slice(0, -1)) {
          if (line.startsWith("event:")) {
            const eventType = line.substring(7).trim();
            const nextIdx = lines.indexOf(lines.find((l) => l.startsWith("data:")) || "");
            if (nextIdx > -1) {
              const dataLine = lines[nextIdx];
              if (dataLine.startsWith("data:")) {
                const data = JSON.parse(dataLine.substring(6));

                if (eventType === "metadata") {
                  if (!ariaMessage) {
                    ariaMessage = {
                      id: data.conversation_id,
                      role: "aria",
                      content: "",
                      timestamp: new Date(),
                      metadata: {
                        mode: data.mode,
                        sources: data.accessed_domains,
                      },
                    };
                    this.addMessage(messagesContainer, ariaMessage);
                  }
                } else if (eventType === "delta" && ariaMessage) {
                  ariaMessage.content += data.delta;
                  this.updateLastMessage(messagesContainer, ariaMessage);
                } else if (eventType === "action") {
                  if (!ariaMessage) ariaMessage = {
                    id: data.id || `aria-${Date.now()}`,
                    role: "aria",
                    content: "",
                    timestamp: new Date(),
                  };
                  if (!ariaMessage.actions) ariaMessage.actions = [];
                  ariaMessage.actions.push(data);
                  this.updateLastMessage(messagesContainer, ariaMessage);
                }
              }
            }
          }
        }
        buffer = lines[lines.length - 1];
      }
    } catch (error) {
      console.error("Aria query error:", error);
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        role: "aria",
        content: `Error: ${(error as Error).message}`,
        timestamp: new Date(),
      };
      this.addMessage(messagesContainer, errorMessage);
    }

    if (typingIndicator) typingIndicator.style.display = "none";
    this.saveConversation(userMessage);
  }

  private addMessage(
    container: Element | null,
    message: Message
  ) {
    if (!container) return;

    const msgEl = document.createElement("div");
    msgEl.className = `aria-message aria-message-${message.role}`;
    msgEl.innerHTML = this.formatMessageHTML(message);
    container.appendChild(msgEl);

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  private updateLastMessage(
    container: Element | null,
    message: Message
  ) {
    if (!container) return;

    const lastMsg = container.querySelector(".aria-message:last-of-type");
    if (lastMsg) {
      lastMsg.innerHTML = this.formatMessageHTML(message);
    }
  }

  private formatMessageHTML(message: Message): string {
    return `
      <div style="display: flex; gap: 8px;">
        ${
          message.role === "aria"
            ? `<div style="width: 24px; height: 24px; flex-shrink: 0; background: linear-gradient(135deg, #00ff88 0%, #0088ff 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; color: #000;">A</div>`
            : `<div style="width: 24px; height: 24px; flex-shrink: 0; background: #1a3a52; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #00ff88;">👤</div>`
        }
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 11px; color: #6b7280;">
            <span style="font-weight: 600; color: ${message.role === "aria" ? "#00ff88" : "#0088ff"};">${message.role === "aria" ? "ARIA" : "YOU"}</span>
            <span>${message.timestamp.toLocaleTimeString()}</span>
            ${message.metadata?.confidence ? `<span style="color: #ff8800;">◆ ${(message.metadata.confidence * 100).toFixed(0)}%</span>` : ""}
          </div>
          <div style="padding: 8px 12px; background: ${message.role === "aria" ? "rgba(0, 136, 255, 0.1)" : "rgba(0, 255, 136, 0.1)"}; border-left: 2px solid ${message.role === "aria" ? "#0088ff" : "#00ff88"}; border-radius: 2px; word-wrap: break-word; white-space: pre-wrap; font-size: 12px; line-height: 1.5;">
            ${this.escapeHtml(message.content)}
          </div>
          ${
            message.actions && message.actions.length > 0
              ? `
            <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px;">
              ${message.actions
                .map(
                  (action) => `
                <button class="aria-action-btn" style="padding: 4px 8px; font-size: 10px; background: rgba(0, 255, 136, 0.1); border: 1px solid #00ff88; color: #00ff88; border-radius: 2px; cursor: pointer; transition: all 0.2s;">
                  ✓ ${action.widget_name}
                </button>
              `
                )
                .join("")}
            </div>
          `
              : ""
          }
        </div>
      </div>
    `;
  }

  private loadConversation(): Message[] {
    try {
      const data = localStorage.getItem(this.cacheKey);
      return data ? JSON.parse(data).map((msg: any) => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
      })) : [];
    } catch {
      return [];
    }
  }

  private saveConversation(message: Message) {
    try {
      const conversation = this.loadConversation();
      conversation.push(message);
      // Keep only last 50 messages
      if (conversation.length > 50) {
        conversation.shift();
      }
      localStorage.setItem(this.cacheKey, JSON.stringify(conversation));
    } catch (error) {
      console.warn("Failed to save conversation:", error);
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}
