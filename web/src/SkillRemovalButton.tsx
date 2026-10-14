import { useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import ShelfButton from './ShelfButton';
import { DiscoveryDialog } from './DiscoverWorkspace';
import { request } from './api';
import type { Skill, Snapshot } from './types';

type Plan = { planId: string; name: string; paths: string[]; warning: string };
export default function SkillRemovalButton({ skill, onState, onNotice, disabled }: { skill: Skill; onState: (state: Snapshot) => void; onNotice: (message: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false), [plan, setPlan] = useState<Plan | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function preview() {
    setOpen(true); setPlan(null); setError(''); setBusy(true);
    try { setPlan(await request<Plan>('/skills/remove/preview', 'POST', { skillId: skill.id })); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!plan) return;
    setBusy(true); setError('');
    try { const result = await request<{ state: Snapshot }>('/skills/remove', 'POST', { planId: plan.planId, confirmed: true }); onState(result.state); onNotice(`${plan.name} 已移除。`); setOpen(false); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <><ShelfButton size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void preview()}><Trash2 />移除安装</ShelfButton>{open && <DiscoveryDialog title={`移除 ${skill.name}`} description="删除选中的本地安装及其共享目录接入链接。独立 Pack 副本会保留。" locked={busy} onClose={() => setOpen(false)}><div className="discovery-dialog-body">{!plan && busy ? <p className="discovery-status"><LoaderCircle className="spin" />正在检查安装目录…</p> : null}{plan && <><p>以下文件和目录将被删除；此操作不可撤销。请先备份需要保留的内容。</p><ul className="discovery-removal-paths">{plan.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul><p className="discovery-safety-note">删除前会再次校验目录；若内容在确认后发生变化，将停止操作。</p></>}{error && <p className="discovery-error" role="alert">{error}</p>}</div><footer className="discovery-dialog-footer"><ShelfButton variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</ShelfButton>{!plan && !busy ? <ShelfButton variant="outline" onClick={() => void preview()}>重新检查</ShelfButton> : <ShelfButton variant="destructive" disabled={busy || !plan} onClick={() => void remove()}>{busy ? <LoaderCircle className="spin" /> : <Trash2 />}{busy ? '正在处理…' : '确认移除'}</ShelfButton>}</footer></DiscoveryDialog>}</>;
}
