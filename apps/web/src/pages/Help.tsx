export function Help() {
  return (
    <div className="space-y-8 max-w-4xl">
      <section>
        <h2 className="text-xl font-bold mb-2">What is this app?</h2>
        <p className="text-sm text-slate-300 leading-relaxed">
          <strong>Video Collector</strong> is a stock-footage acquisition &amp; rights-management
          system for the &ldquo;The World Is Ours&rdquo; YouTube music video. It searches the official
          Pexels and Pixabay APIs, filters / scores / deduplicates candidates, downloads the top
          candidates per shot, generates thumbnails + contact sheets, drives a human review UI, and
          emits provenance / license manifests targeting ~100 commercially suitable candidates mapped
          to a 100-shot creative plan.
        </p>
        <p className="text-xs text-slate-400 mt-2">
          Scope is P0 + P1 only — no AI vision analysis, no in-app video editor. The DB keeps P2
          fields nullable so they can be added later without migrations.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">The workflow</h2>
        <ol className="space-y-3">
          <Step n={1} title="Seed the 100-shot creative plan">
            Run <Cmd>npm run seed</Cmd> (also runs migrations). This creates the SQLite DB and loads
            the 100-shot dataset that drives every search.
          </Step>
          <Step n={2} title="Acquire candidates">
            On the <strong>Dashboard</strong>, click <em>Run acquisition (all shots)</em> to search
            every shot, or open a shot on the <strong>Timeline</strong> page and click
            <em> Acquire candidates</em> for a single shot. The pipeline downloads top candidates,
            runs ffprobe, SHA-256, thumbnails, pHash and dedup on each file. Progress is shown live.
          </Step>
          <Step n={3} title="Review each shot">
            On the <strong>Timeline</strong> page, open any shot to see its candidate assets as cards
            with thumbnail, dimensions, duration, provider, license status, creator and source /
            license links. For each downloaded asset choose:
            <ul className="mt-2 ml-4 list-disc text-xs text-slate-300 space-y-1">
              <li><span className="text-emerald-400 font-semibold">KEEP</span> — approve for edit</li>
              <li><span className="text-rose-400 font-semibold">REJECT</span> — discard the asset</li>
              <li><span className="text-amber-400 font-semibold">REVIEW RIGHTS</span> — flag for
                manual rights review before approval</li>
            </ul>
          </Step>
          <Step n={4} title="Generate manifests">
            Back on the <strong>Dashboard</strong>, click <em>Generate manifests</em> to write CSV /
            JSON / HTML provenance + license reports and contact sheets into
            <Cmd>THE_WORLD_IS_OURS/manifests/</Cmd>. Use <em>Reserve pool</em> to pull extra
            candidates for shots that still need approval.
          </Step>
        </ol>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">Asset states</h2>
        <p className="text-sm text-slate-300 mb-3">
          Each asset moves through a state machine. Only <code>LICENSE_SOURCE_CONFIRMED</code> and
          human-approved <code>RIGHTS_REVIEW_REQUIRED</code> assets may reach
          <code> APPROVED_FOR_EDIT</code>. <code>UNKNOWN → APPROVED_FOR_EDIT</code> is impossible.
        </p>
        <div className="ui-card p-4 text-xs font-mono text-slate-300 overflow-x-auto">
          DISCOVERED → TECHNICALLY_VALID → LICENSE_SOURCE_CONFIRMED → AI_REVIEWED
          {"\n"}{"  "}→ HUMAN_REVIEW_REQUIRED → APPROVED_FOR_EDIT
          {"\n"}{"\n"}REJECTED is reachable from DISCOVERED, TECHNICALLY_VALID,
          {"\n"}LICENSE_SOURCE_CONFIRMED, AI_REVIEWED, HUMAN_REVIEW_REQUIRED, RIGHTS_RISK.
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">No mock / dry-run mode</h2>
        <p className="text-sm text-slate-300 leading-relaxed">
          There is <strong>no mock fallback</strong>. If a provider API key is missing or any
          provider call fails, the system signals an error immediately — it never fabricates or
          synthesizes data. Make sure <Cmd>PEXELS_API_KEY</Cmd> and <Cmd>PIXABAY_API_KEY</Cmd> are
          set in <Cmd>.env.local</Cmd> before running acquisition.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">Legal principle</h2>
        <p className="text-sm text-slate-300 leading-relaxed">
          The app distinguishes <code>LICENSE_SOURCE_CONFIRMED</code>,
          <code> RIGHTS_REVIEW_REQUIRED</code>, <code>NOT_APPROVED</code> and <code>UNKNOWN</code>.
          The dashboard shows <em>&ldquo;Source license verified: N/100&rdquo;</em> — never
          &ldquo;100% legally safe&rdquo;. This is a rights-management aid, not a legal opinion.
          Never infer legal clearance from search-result availability.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold mb-3">Common commands</h2>
        <table className="w-full text-sm ui-card overflow-hidden">
          <tbody>
            {[
              ["npm run dev", "Backend :3001 + web :5174"],
              ["npm run seed", "Migrate + seed the 100-shot dataset"],
              ["npm run acquire", "Acquire all shots (requires API keys)"],
              ["npm run manifests", "Generate CSV/JSON/HTML manifests + contact sheets"],
              ["npm run typecheck", "Typecheck all workspaces"],
              ["npm test", "Run all tests"],
            ].map(([cmd, desc]) => (
              <tr key={cmd} className="border-b border-slate-700 last:border-0">
                <td className="px-3 py-2 font-mono text-xs text-sky-400 whitespace-nowrap align-top">{cmd}</td>
                <td className="px-3 py-2 text-slate-300">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex-none w-6 h-6 rounded-full bg-sky-600 text-white text-xs font-bold flex items-center justify-center mt-0.5">
        {n}
      </span>
      <div className="text-sm text-slate-300">
        <div className="font-semibold text-slate-100">{title}</div>
        <div className="mt-1 leading-relaxed">{children}</div>
      </div>
    </li>
  );
}

function Cmd({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs text-sky-400 bg-slate-800/60 px-1.5 py-0.5 rounded">{children}</code>;
}
