declare module '@/workers/analysis.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}

declare module '@/workers/ml.worker?worker' {
  const WorkerFactory: {
    new (): Worker;
  };
  export default WorkerFactory;
}
