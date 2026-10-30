import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
  const inference = vi.fn();

  return {
    inference,
    pipeline: vi.fn(async () => inference),
  };
});

vi.mock('@xenova/transformers', () => ({
  env: {},
  pipeline: mocks.pipeline,
}));

const workerScope = {
  postMessage: vi.fn(),
  onmessage: null as
    | ((event: MessageEvent) => Promise<void>)
    | null,
};

beforeAll(async () => {
  vi.stubGlobal('self', workerScope);
  await import('@/workers/ml.worker');
});

beforeEach(() => {
  workerScope.postMessage.mockClear();
  mocks.inference.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

let requestId = 0;

async function runNER(
  texts: string[],
  outputs: unknown[],
) {
  for (const output of outputs) {
    mocks.inference.mockResolvedValueOnce(output);
  }

  const id = `ner-test-${++requestId}`;

  await workerScope.onmessage!({
    data: {
      type: 'extract-entities',
      id,
      texts,
    },
  } as MessageEvent);

  const response = workerScope.postMessage.mock.calls
    .map(([message]) => message)
    .find(message => message.id === id);

  expect(response?.type).toBe('entities-result');

  return response.entities;
}

describe('NER worker output regression', () => {

  it('accepts raw Xenova v2 entity output', async () => {
    const result = await runNER(
      ['Explosion reported in Berlin'],
      [[{
        entity: 'B-LOC',
        word: 'Berlin',
        score: 0.98,
        start: null,
        end: null,
      }]],
    );

    expect(result).toEqual([[
      {
        text: 'Berlin',
        type: 'B-LOC',
        confidence: 0.98,
        start: null,
        end: null,
      },
    ]]);

    expect(mocks.inference)
      .toHaveBeenCalledWith('Explosion reported in Berlin');
  });

  it('also accepts grouped entity output', async () => {
    const result = await runNER(
      ['NATO meets in Brussels'],
      [[{
        entity_group: 'ORG',
        word: 'NATO',
        score: 0.97,
        start: 0,
        end: 4,
      }]],
    );

    expect(result[0][0].type).toBe('ORG');
    expect(result[0][0].text).toBe('NATO');
  });

  it('rejects malformed entities without crashing', async () => {
    const result = await runNER(
      ['Invalid model response'],
      [[
        null,
        { entity: undefined, word: 'Berlin', score: 0.9 },
        { entity: 'B-LOC', word: null, score: 0.9 },
        { entity: 'B-LOC', word: 'Paris', score: NaN },
        { entity: 'O', word: 'hello', score: 0.9 },
        {
          entity: 'B-PER',
          word: 'Alice',
          score: 0.95,
          start: -1,
          end: null,
        },
      ]],
    );

    expect(result).toEqual([[
      {
        text: 'Alice',
        type: 'B-PER',
        confidence: 0.95,
        start: null,
        end: null,
      },
    ]]);
  });

  it('handles empty model results', async () => {
    const result = await runNER(
      ['Nothing detected'],
      [[]],
    );

    expect(result).toEqual([[]]);
  });

  it('keeps results aligned with multiple headlines', async () => {
    const result = await runNER(
      ['Berlin update', 'Microsoft investment'],
      [
        [{
          entity: 'B-LOC',
          word: 'Berlin',
          score: 0.99,
        }],
        [{
          entity: 'B-ORG',
          word: 'Microsoft',
          score: 0.96,
        }],
      ],
    );

    expect(result).toHaveLength(2);
    expect(result[0][0].text).toBe('Berlin');
    expect(result[1][0].text).toBe('Microsoft');
  });

});
