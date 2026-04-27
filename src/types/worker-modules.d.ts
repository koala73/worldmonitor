declare module '@/workers/analysis.worker?worker' {
  const AnalysisWorker: {
    new (): Worker;
  };
  export default AnalysisWorker;
}

declare module '@/workers/ml.worker?worker' {
  const MLWorker: {
    new (): Worker;
  };
  export default MLWorker;
}
