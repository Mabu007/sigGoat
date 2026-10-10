import React, { useState } from 'react';
import { useGoat } from '../../context/GoatContext';
import { TradingSkill } from '../../types';
import { SkillParser } from '../../services/agent/SkillParser';
import { Sparkles, Trash2, Plus, FileText, Code2, Eye, ShieldCheck, Clock, Check, Copy } from 'lucide-react';

const STARTER_MARKDOWN_TEMPLATE = `---
id: london-breakout
name: London Breakout Strategy
timeframes: 15m, 1h
---

# London Breakout Strategy

Look for meaningful expansion around the London session open (07:00 - 10:30 UTC).
Prefer higher-timeframe structure alignment on the venue's currency perpetuals (xyz:EUR, xyz:GBP) or your chosen crypto majors.
Do not treat the first initial breakout spike as automatically valid.

## Thesis Formation
- Require evidence that the breakout has real momentum and displacement.
- Map the prior Asian consolidation range high and low.
- Look for early fakeout sweeps before the true session expansion direction begins.

## Event Interpretation
- Look for continuation or rejection at key session boundaries.
- When price pulls back to the broken breakout level, evaluate for a conditional limit entry.

## Constraints
REQUIRE_INVALIDATION_BEFORE_TRADE
REQUIRE_EVIDENCE_BEFORE_ACTIONABLE
WAIT_FOR_SESSION_OPEN_CONFIRMATION
MINIMUM_RR_2_TO_1
LIMIT_ORDERS_ONLY

## Invalidation Rules
Price closes back inside the opposite half of the Asian consolidation zone.
`;

export const SkillsView: React.FC = () => {
  const { skills, createSkill, deleteSkill } = useGoat();
  const [selectedSkill, setSelectedSkill] = useState<TradingSkill | null>(skills[0] || null);
  const [isOpenCreateModal, setIsOpenCreateModal] = useState(false);
  const [markdownInput, setMarkdownInput] = useState(STARTER_MARKDOWN_TEMPLATE);
  const [previewMode, setPreviewMode] = useState<'editor' | 'preview'>('editor');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // Inspector tab
  const [viewTab, setViewTab] = useState<'markdown' | 'parsed'>('markdown');

  const handleSaveSkill = async () => {
    if (!markdownInput.trim()) {
      setErrorMsg('Please enter Markdown content for your skill.');
      return;
    }
    setErrorMsg('');
    setIsSubmitting(true);
    try {
      const parsed = SkillParser.parse(markdownInput.trim());
      const created = await createSkill({
        name: parsed.name,
        description: parsed.description,
        methodology: parsed.methodology,
        constraints: parsed.constraints,
        preferredTimeframes: parsed.preferredTimeframes,
        requiredEvidence: parsed.requiredEvidence,
        invalidationRules: parsed.invalidationRules,
        rawMarkdown: parsed.rawMarkdown,
      });
      setSelectedSkill(created);
      setIsOpenCreateModal(false);
      setMarkdownInput(STARTER_MARKDOWN_TEMPLATE);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to parse and save Markdown skill');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyMarkdown = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteSkill(id);
      if (selectedSkill?.id === id) {
        setSelectedSkill(skills.find(s => s.id !== id) || null);
      }
    } catch (err: any) {
      console.error(err);
    }
  };

  const currentMarkdown = selectedSkill?.rawMarkdown || `---
id: ${selectedSkill?.id}
name: ${selectedSkill?.name}
---

# ${selectedSkill?.name}

${selectedSkill?.description}

## Methodology
${selectedSkill?.methodology}

## Constraints
${selectedSkill?.constraints}

## Preferred Timeframes
${selectedSkill?.preferredTimeframes?.join(', ')}

## Required Evidence
${selectedSkill?.requiredEvidence}

## Invalidation Rules
${selectedSkill?.invalidationRules}
`;

  return (
    <div className="space-y-6 pb-20">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-fg flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-accent-text" />
            <span>Trading Skills &amp; Methodology Catalog</span>
          </h1>
          <p className="text-xs text-fg-muted mt-0.5">
            Skills are native Markdown files containing instructions, thesis rules, and deterministic constraints that shape GOAT reasoning.
          </p>
        </div>

        <button
          onClick={() => {
            setMarkdownInput(STARTER_MARKDOWN_TEMPLATE);
            setIsOpenCreateModal(true);
          }}
          className="self-start sm:self-auto flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-accent-fg font-bold text-xs py-2 px-3.5 rounded-xl transition-colors shadow-sm cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Write Markdown Skill</span>
        </button>
      </div>

      {/* Main Grid: Skills List + Detailed Card */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Left Column: Skills Catalog */}
        <div className="md:col-span-1 space-y-2.5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-fg-muted px-1">
            Available Skills ({skills.length})
          </div>

          <div className="space-y-2">
            {skills.map(s => {
              const isSelected = selectedSkill?.id === s.id;
              return (
                <div
                  key={s.id}
                  onClick={() => setSelectedSkill(s)}
                  className={`cursor-pointer p-3 rounded-xl border text-left transition-colors relative ${
                    isSelected
                      ? 'bg-accent-soft border-accent/40 text-fg'
                      : 'bg-surface border-line text-fg-muted hover:border-line-strong'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold">{s.name}</span>
                    {s.isDefault ? (
                      <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 bg-sunken text-fg-muted rounded">
                        Built-in
                      </span>
                    ) : (
                      <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 bg-accent/20 text-accent-text rounded">
                        Custom .md
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-fg-muted line-clamp-2 mt-1">
                    {s.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Skill Detail Inspector */}
        <div className="md:col-span-2">
          {selectedSkill ? (
            <div className="bg-surface border border-line rounded-2xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-fg">{selectedSkill.name}</h2>
                  {selectedSkill.isDefault ? (
                    <span className="text-[10px] text-fg-muted font-mono bg-sunken border border-line px-2 py-0.5 rounded">
                      Standard Library
                    </span>
                  ) : (
                    <span className="text-[10px] text-accent-text font-mono bg-accent-soft border border-accent/40 px-2 py-0.5 rounded">
                      User Defined Markdown
                    </span>
                  )}
                </div>

                {/* View switcher (Markdown vs Normalized view) */}
                <div className="flex items-center gap-1 bg-sunken p-0.5 rounded-lg border border-line text-xs">
                  <button
                    onClick={() => setViewTab('markdown')}
                    className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
                      viewTab === 'markdown' ? 'bg-accent text-accent-fg font-bold' : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    <Code2 className="w-3.5 h-3.5" />
                    <span>Markdown Source</span>
                  </button>
                  <button
                    onClick={() => setViewTab('parsed')}
                    className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1.5 ${
                      viewTab === 'parsed' ? 'bg-accent text-accent-fg font-bold' : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>Normalized Rules</span>
                  </button>
                </div>
              </div>

              {viewTab === 'markdown' ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs text-fg-muted">
                    <span className="font-mono text-[11px] text-fg-muted">skill.md (pristine source)</span>
                    <button
                      onClick={() => handleCopyMarkdown(currentMarkdown)}
                      className="flex items-center gap-1 text-[11px] text-fg-muted hover:text-accent-text transition-colors"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-positive" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? 'Copied' : 'Copy Markdown'}</span>
                    </button>
                  </div>
                  <pre className="bg-sunken border border-line rounded-xl p-4 text-xs font-mono text-fg-muted overflow-x-auto whitespace-pre-wrap max-h-96 leading-relaxed selection:bg-accent/30">
                    {currentMarkdown}
                  </pre>
                </div>
              ) : (
                <div className="space-y-4 text-xs">
                  <div>
                    <h3 className="font-semibold text-fg-muted mb-1 flex items-center gap-1.5">
                      <FileText className="w-4 h-4 text-accent-text" />
                      <span>Methodology Description</span>
                    </h3>
                    <p className="text-fg-muted leading-relaxed bg-sunken/60 p-3 rounded-xl border border-line/60">
                      {selectedSkill.methodology}
                    </p>
                  </div>

                  <div>
                    <h3 className="font-semibold text-fg-muted mb-1 flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-positive" />
                      <span>Recognized Constraints &amp; Rules</span>
                    </h3>
                    <div className="bg-sunken/60 p-3 rounded-xl border border-line/60 font-mono text-[11px] text-positive">
                      {selectedSkill.constraints}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="bg-sunken/40 p-3 rounded-xl border border-line/60">
                      <h4 className="text-[11px] font-bold text-fg-muted uppercase tracking-wider mb-1 flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-info" />
                        <span>Preferred Timeframes</span>
                      </h4>
                      <div className="flex gap-1.5 mt-1.5">
                        {selectedSkill.preferredTimeframes?.map(tf => (
                          <span key={tf} className="px-2 py-0.5 bg-raised text-info font-mono text-[10px] rounded border border-line-strong">
                            {tf}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="bg-sunken/40 p-3 rounded-xl border border-line/60">
                      <h4 className="text-[11px] font-bold text-fg-muted uppercase tracking-wider mb-1">
                        Invalidation Policy
                      </h4>
                      <p className="text-fg-muted text-[11px]">
                        {selectedSkill.invalidationRules}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Action Bar */}
              <div className="flex items-center justify-between pt-3 border-t border-line">
                <span className="text-[11px] text-fg-muted">
                  Attached to GOAT reasoning prompts and backtesting loops automatically.
                </span>
                {!selectedSkill.isDefault && (
                  <button
                    onClick={() => handleDelete(selectedSkill.id)}
                    className="flex items-center gap-1 text-xs text-negative hover:text-negative px-3 py-1.5 rounded-lg hover:bg-negative-soft transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Skill</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="h-64 border border-dashed border-line rounded-2xl flex items-center justify-center text-xs text-fg-muted">
              Select a skill from the catalog or write a new Markdown skill.
            </div>
          )}
        </div>
      </div>

      {/* CREATE SKILL MODAL (MARKDOWN AUTHORING) */}
      {isOpenCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-surface border border-line rounded-2xl max-w-2xl w-full p-5 sm:p-6 space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h3 className="text-base font-bold text-fg flex items-center gap-2">
                  <Code2 className="w-5 h-5 text-accent-text" />
                  <span>Author Markdown Skill</span>
                </h3>
                <p className="text-xs text-fg-muted mt-0.5">
                  Write your strategy in natural Markdown. The parser extracts frontmatter, instructions, and constraints.
                </p>
              </div>

              {/* Editor / Preview toggle */}
              <div className="flex items-center gap-1 bg-sunken p-0.5 rounded-lg border border-line text-xs">
                <button
                  type="button"
                  onClick={() => setPreviewMode('editor')}
                  className={`px-2.5 py-1 rounded font-medium transition-colors ${
                    previewMode === 'editor' ? 'bg-accent text-accent-fg font-bold' : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  Editor
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewMode('preview')}
                  className={`px-2.5 py-1 rounded font-medium transition-colors ${
                    previewMode === 'preview' ? 'bg-accent text-accent-fg font-bold' : 'text-fg-muted hover:text-fg'
                  }`}
                >
                  Parsed Preview
                </button>
              </div>
            </div>

            {errorMsg && (
              <div className="p-3 bg-negative-soft border border-negative/40 text-negative rounded-xl text-xs">
                {errorMsg}
              </div>
            )}

            <div className="flex-1 overflow-y-auto min-h-[300px]">
              {previewMode === 'editor' ? (
                <div className="space-y-2 h-full">
                  <div className="flex items-center justify-between text-[11px] text-fg-muted">
                    <span>Supports frontmatter, # Titles, ## Constraints, and free-form methodology text</span>
                    <button
                      type="button"
                      onClick={() => setMarkdownInput(STARTER_MARKDOWN_TEMPLATE)}
                      className="text-accent-text hover:underline"
                    >
                      Reset to Template
                    </button>
                  </div>
                  <textarea
                    value={markdownInput}
                    onChange={e => setMarkdownInput(e.target.value)}
                    rows={14}
                    placeholder="Write your markdown skill here..."
                    className="w-full h-80 bg-sunken border border-line rounded-xl p-3.5 text-xs font-mono text-fg placeholder-fg-subtle focus:outline-none focus:border-focus resize-none leading-relaxed"
                  />
                </div>
              ) : (
                <div className="space-y-3 p-3 bg-sunken/60 rounded-xl border border-line text-xs">
                  {(() => {
                    const parsed = SkillParser.parse(markdownInput);
                    return (
                      <>
                        <div className="border-b border-line pb-2">
                          <span className="text-[10px] uppercase font-mono text-accent-text">Detected Name:</span>
                          <div className="text-sm font-bold text-fg">{parsed.name}</div>
                          <div className="text-xs text-fg-muted mt-0.5">{parsed.description}</div>
                        </div>
                        <div>
                          <span className="text-[10px] uppercase font-mono text-fg-muted">Extracted Constraints:</span>
                          <div className="text-xs font-mono text-positive mt-0.5">{parsed.constraints}</div>
                        </div>
                        <div>
                          <span className="text-[10px] uppercase font-mono text-fg-muted">Preferred Timeframes:</span>
                          <div className="flex gap-1.5 mt-1">
                            {parsed.preferredTimeframes.map(tf => (
                              <span key={tf} className="px-2 py-0.5 bg-raised text-info font-mono text-[10px] rounded">
                                {tf}
                              </span>
                            ))}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
              <button
                type="button"
                onClick={() => setIsOpenCreateModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-fg-muted hover:text-fg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveSkill}
                disabled={isSubmitting}
                className="bg-accent hover:bg-accent-hover text-accent-fg font-bold text-xs py-2 px-5 rounded-xl transition-colors cursor-pointer"
              >
                {isSubmitting ? 'Parsing & Saving...' : 'Save Markdown Skill'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
