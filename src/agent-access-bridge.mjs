import { join } from 'node:path';
import { AgentAccessService } from './agent-access.mjs';
import { workbenchRegistry } from './workbench.mjs';
import { ShelfError } from './domain.mjs';

export class AgentAccessBridge {
  constructor(service) {
    this.service = service;
    this.access = new AgentAccessService(join(service.dataDir, 'agent-skill-access.json'), [], join(service.homeDir, '.agents', 'skills'));
  }

  run(action) {
    return this.service.read(async () => {
      this.access.registry = workbenchRegistry(this.service.workbenchInput()).map(agent => ({
        id: agent.id, name: agent.name, skillDirectories: agent.skillDirectories ?? [agent.path],
      }));
      try { return await action(this.access); }
      catch (error) { throw new ShelfError(error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 409, error.message); }
    });
  }

  get(id) { return this.run(access => access.getSnapshot(id)); }
  preview(input) { return this.run(access => access.preview(input)); }
  discard(id) { return this.run(async access => { await access.discard(id); return { discarded: true }; }); }
  apply(id) { return this.run(access => access.apply(id)); }
  openFolder(input, opener) { return this.run(async access => { await opener(await access.getFolderPath(input)); return { opened: true }; }); }
}
