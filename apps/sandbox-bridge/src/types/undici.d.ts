declare module "undici" {
  interface AgentOptions {
    headersTimeout?: number;
    bodyTimeout?: number;
  }

  class Agent {
    constructor(options?: AgentOptions);
  }

  function setGlobalDispatcher(dispatcher: Agent): void;
}
