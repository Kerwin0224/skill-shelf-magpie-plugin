import { request } from './api';
import type { AgentAccessPreview, AgentSkillAccessSnapshot, PreviewAgentAccessInput } from './agent-access-types';

export const agentAccessApi = {
  getAgentSkillAccess: (id: string) => request<AgentSkillAccessSnapshot>(`/agent-access?id=${encodeURIComponent(id)}`),
  previewAgentSkillAccess: (input: PreviewAgentAccessInput) => request<AgentAccessPreview>('/agent-access/preview', 'POST', input),
  applyAgentSkillAccess: (id: string) => request<AgentSkillAccessSnapshot>('/agent-access/apply', 'POST', { id }),
  discardAgentSkillAccessPreview: (id: string) => request('/agent-access/discard', 'POST', { id }),
  openAgentSkillAccessFolder: (input: { agentId: string; skillName: string; location: 'source' | 'target' }) => request('/agent-access/open-folder', 'POST', input),
};
