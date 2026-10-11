export type IntegrationToolMeta = {
  name: string;
  description: string;
};

export type IntegrationToolEntry = {
  key: string;
  displayName: string;
  description: string;
  tools: IntegrationToolMeta[];
};
