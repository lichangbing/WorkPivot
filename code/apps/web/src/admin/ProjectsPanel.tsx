import { useEffect, useState } from 'react';
import { api, type Project } from '../api';

export function ProjectsPanel(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { void api.listProjects().then((v) => setProjects(v.projects)).catch((e: unknown) => setError(String(e))); }, []);
  return <div className="max-w-3xl space-y-4">
    <h2 className="font-semibold">我的项目</h2>
    <p className="text-xs text-neutral-400">每个账号拥有独立空间，管理员也只能查看自己的项目。</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {projects.map((project) => <section key={project.id} className="rounded border border-neutral-700 bg-neutral-900 p-4">
      <h3 className="text-sm font-medium">{project.name}</h3>
      <p className="mt-1 break-all text-xs text-neutral-400">{project.directory}</p>
    </section>)}
  </div>;
}
