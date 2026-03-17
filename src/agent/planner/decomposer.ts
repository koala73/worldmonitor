/**
 * Goal Decomposition & Task Planner
 *
 * Breaks high-level intelligence objectives into ordered task queues.
 * Handles priority scheduling, dependency resolution, and adaptive
 * replanning when tasks fail or new observations arise.
 */

import type {
  Goal,
  Task,
  TaskPriority,
  TaskStatus,
  Observation,
} from '../types';
import { agentBus } from '../bus/event-bus';

let goalCounter = 0;
let taskCounter = 0;

// ============================================================================
// GOAL TEMPLATES — predefined intelligence objectives
// ============================================================================

export interface GoalTemplate {
  id: string;
  name: string;
  /** When should this goal be auto-created? */
  trigger: 'startup' | 'observation' | 'schedule' | 'manual';
  /** Priority (0 = highest) */
  priority: number;
  /** What tools and parameters to use */
  taskSpecs: TaskSpec[];
  /** Success criteria descriptions */
  successCriteria: string[];
}

export interface TaskSpec {
  toolId: string;
  toolInput: Record<string, unknown>;
  priority: TaskPriority;
  dependencies?: string[];
  description: string;
  maxRetries?: number;
}

/**
 * Built-in goal templates for the intelligence cycle.
 */
export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    id: 'gt-full-sweep',
    name: 'Full Intelligence Sweep',
    trigger: 'startup',
    priority: 0,
    successCriteria: [
      'All domain tools executed successfully',
      'Pipeline produced at least one finding',
      'No fatal invariant violations',
    ],
    taskSpecs: [
      { toolId: 'news.rss', toolInput: { maxItems: 50 }, priority: 'high', description: 'Fetch latest news clusters' },
      { toolId: 'conflict.acled', toolInput: {}, priority: 'high', description: 'Fetch conflict events' },
      { toolId: 'military.flights', toolInput: {}, priority: 'medium', description: 'Fetch military aviation' },
      { toolId: 'cyber.threats', toolInput: {}, priority: 'medium', description: 'Fetch cyber threats' },
      { toolId: 'seismology.earthquakes', toolInput: {}, priority: 'low', description: 'Fetch earthquake data' },
      { toolId: 'economic.macro', toolInput: {}, priority: 'medium', description: 'Fetch macro signals' },
      { toolId: 'infrastructure.outages', toolInput: {}, priority: 'medium', description: 'Fetch outages' },
      { toolId: 'unrest.events', toolInput: {}, priority: 'medium', description: 'Fetch unrest events' },
      { toolId: 'intelligence.risk', toolInput: {}, priority: 'high', description: 'Compute risk scores' },
    ],
  },
  {
    id: 'gt-market-scan',
    name: 'Market & Sector Analysis',
    trigger: 'schedule',
    priority: 5,
    successCriteria: [
      'Sector data for all 11 GICS sectors',
      'Rotation signal detected or confirmed absent',
      'Earnings momentum computed where available',
    ],
    taskSpecs: [
      { toolId: 'market.sp500sectors', toolInput: {}, priority: 'high', description: 'Monitor all SP500 sectors' },
      { toolId: 'market.earnings', toolInput: { lookbackDays: 7 }, priority: 'high', description: 'Capture recent earnings' },
      { toolId: 'economic.macro', toolInput: {}, priority: 'medium', description: 'Fetch macro context' },
    ],
  },
  {
    id: 'gt-crisis-focus',
    name: 'Crisis Region Focus',
    trigger: 'observation',
    priority: 1,
    successCriteria: [
      'Region-specific conflict and unrest data collected',
      'Military activity assessed',
      'Infrastructure status checked',
    ],
    taskSpecs: [
      { toolId: 'conflict.acled', toolInput: {}, priority: 'critical', description: 'Fetch conflict events for region' },
      { toolId: 'military.flights', toolInput: {}, priority: 'critical', description: 'Check military activity' },
      { toolId: 'infrastructure.outages', toolInput: {}, priority: 'high', description: 'Check infrastructure' },
      { toolId: 'intelligence.risk', toolInput: {}, priority: 'high', description: 'Compute focused risk scores' },
      { toolId: 'unrest.events', toolInput: {}, priority: 'high', description: 'Fetch regional unrest' },
    ],
  },
  {
    id: 'gt-earnings-deep',
    name: 'Deep Earnings Analysis',
    trigger: 'manual',
    priority: 3,
    successCriteria: [
      'Earnings data collected for all target sectors',
      'Momentum calculated per sector',
      'Cross-sector rotation signal produced',
    ],
    taskSpecs: [
      { toolId: 'market.earnings', toolInput: { lookbackDays: 30, lookforwardDays: 14 }, priority: 'high', description: 'Deep earnings lookback' },
      { toolId: 'market.sp500sectors', toolInput: {}, priority: 'high', description: 'Current sector positioning' },
    ],
  },
];

// ============================================================================
// GOAL DECOMPOSER
// ============================================================================

export class GoalDecomposer {
  private activeGoals: Map<string, Goal> = new Map();
  private completedGoals: Goal[] = [];

  /**
   * Create a goal from a template with optional parameter overrides.
   */
  createFromTemplate(
    templateId: string,
    overrides?: { toolInputOverrides?: Record<string, Record<string, unknown>>; rationale?: string },
  ): Goal {
    const template = GOAL_TEMPLATES.find(t => t.id === templateId);
    if (!template) throw new Error(`Unknown goal template: ${templateId}`);

    const goalId = `goal-${++goalCounter}-${Date.now()}`;
    const tasks: Task[] = template.taskSpecs.map((spec) => {
      const taskId = `task-${++taskCounter}`;
      const toolInput = overrides?.toolInputOverrides?.[spec.toolId]
        ? { ...spec.toolInput, ...overrides.toolInputOverrides[spec.toolId] }
        : spec.toolInput;

      return {
        id: taskId,
        goalId,
        description: spec.description,
        status: 'queued' as TaskStatus,
        priority: spec.priority,
        toolId: spec.toolId,
        toolInput: toolInput,
        dependencies: spec.dependencies ?? [],
        queuedAt: Date.now(),
        maxRetries: spec.maxRetries ?? 2,
        retryCount: 0,
      };
    });

    const goal: Goal = {
      id: goalId,
      objective: template.name,
      rationale: overrides?.rationale ?? `Auto-created from template ${templateId}`,
      status: 'active',
      priority: template.priority,
      tasks,
      createdAt: Date.now(),
      successCriteria: template.successCriteria,
    };

    this.activeGoals.set(goalId, goal);
    agentBus.emit('goal:created', { goalId, objective: goal.objective }, 'decomposer');
    return goal;
  }

  /**
   * Create a goal from an observation (reactive planning).
   */
  createFromObservation(observation: Observation): Goal | null {
    if (!observation.actionable) return null;
    if (observation.salience < 60) return null;

    // Determine which template to use based on signal content
    const domains = new Set(
      observation.signals.flatMap(s => s.sources.map(src => src.domain))
    );

    let templateId: string;
    if (domains.has('conflict') || domains.has('military')) {
      templateId = 'gt-crisis-focus';
    } else if (domains.has('economic')) {
      templateId = 'gt-market-scan';
    } else {
      templateId = 'gt-full-sweep';
    }

    const regions = [...new Set(observation.signals.flatMap(s => s.regions))];

    return this.createFromTemplate(templateId, {
      rationale: `Reactive: ${observation.summary}`,
      toolInputOverrides: regions.length > 0
        ? { 'intelligence.risk': { region: regions[0] } }
        : undefined,
    });
  }

  /**
   * Get the next task to execute, respecting priorities and dependencies.
   */
  getNextTask(): { goal: Goal; task: Task } | null {
    const candidates: Array<{ goal: Goal; task: Task; score: number }> = [];

    for (const goal of this.activeGoals.values()) {
      for (const task of goal.tasks) {
        if (task.status !== 'queued') continue;

        // Check dependencies
        const depsComplete = task.dependencies.every(depId => {
          const dep = goal.tasks.find(t => t.id === depId);
          return dep?.status === 'completed';
        });
        if (!depsComplete) continue;

        // Score = goal priority (lower=better) + task priority
        const priorityScore = {
          critical: 0,
          high: 10,
          medium: 20,
          low: 30,
        }[task.priority];

        candidates.push({
          goal,
          task,
          score: goal.priority * 100 + priorityScore,
        });
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0]!;
    return { goal: best.goal, task: best.task };
  }

  /**
   * Mark a task as completed and check if its goal is done.
   */
  completeTask(taskId: string, result: import('../types').TaskResult): void {
    for (const goal of this.activeGoals.values()) {
      const task = goal.tasks.find(t => t.id === taskId);
      if (!task) continue;

      task.status = result.success ? 'completed' : 'failed';
      task.result = result;
      task.completedAt = Date.now();

      agentBus.emit('task:completed', {
        taskId,
        goalId: goal.id,
        success: result.success,
      }, 'decomposer');

      // Check if goal is complete
      const allDone = goal.tasks.every(
        t => t.status === 'completed' || t.status === 'failed'
      );
      if (allDone) {
        const allSuccess = goal.tasks.every(t => t.status === 'completed');
        goal.status = allSuccess ? 'completed' : 'failed';
        goal.resolvedAt = Date.now();
        this.activeGoals.delete(goal.id);
        this.completedGoals.push(goal);

        const eventType = allSuccess ? 'goal:completed' : 'goal:failed';
        agentBus.emit(eventType, { goalId: goal.id }, 'decomposer');
      }

      return;
    }
  }

  /**
   * Retry a failed task if within retry limits.
   */
  retryTask(taskId: string): boolean {
    for (const goal of this.activeGoals.values()) {
      const task = goal.tasks.find(t => t.id === taskId);
      if (!task || task.status !== 'failed') continue;

      if (task.retryCount >= task.maxRetries) return false;

      task.status = 'queued';
      task.retryCount++;
      task.result = undefined;
      task.completedAt = undefined;
      return true;
    }
    return false;
  }

  getActiveGoals(): Goal[] {
    return [...this.activeGoals.values()];
  }

  getCompletedGoals(): Goal[] {
    return [...this.completedGoals];
  }
}
