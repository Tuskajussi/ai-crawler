import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Check, Cloud, Cpu, Eye, FileSearch, Layers3, Network, Plus, Search, ShieldCheck, X } from 'lucide-react';
import type { AgentData, ModelConfig } from '../shared/types';
import { compatibleTemplateModels, instantiateNodeTemplate, nodeTemplateCategories, nodeTemplates, suggestedTemplateModel, type NodeTemplate } from '../shared/node-library';
import './node-library.css';

interface NodeLibraryProps {
  models: ModelConfig[];
  supervisorModelId?: string;
  disabledReason?: string;
  onAdd: (data: AgentData) => void;
  onClose: () => void;
  onManageModels: () => void;
}

const categoryIcons = { discover: FileSearch, review: ShieldCheck, visual: Eye, coordinate: Network };
const categoryDescriptions = {
  discover: 'Understand the project and find where to focus.',
  review: 'Check correctness, reliability, and important edge cases.',
  visual: 'Inspect the interface and how people use it.',
  coordinate: 'Organize findings, handoffs, and your own roles.',
};
const categoryLabel = (category: NodeTemplate['category']) => nodeTemplateCategories.find(item => item.id === category)?.label ?? category;
const toolLabels = { read: 'Read project files', screenshot: 'Capture local UI' };

export function NodeLibrary({ models, supervisorModelId, disabledReason, onAdd, onClose, onManageModels }: NodeLibraryProps) {
  const titleId = useId();
  const descriptionId = useId();
  const availabilityId = useId();
  const templatesId = useId();
  const previewId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | NodeTemplate['category']>('all');
  const [selectedId, setSelectedId] = useState<string>();
  const [modelId, setModelId] = useState('');
  const selectedTemplate = nodeTemplates.find(template => template.id === selectedId);
  const compatibleModels = useMemo(() => selectedTemplate ? compatibleTemplateModels(selectedTemplate, models) : [], [selectedTemplate, models]);
  const selectedModel = compatibleModels.find(model => model.id === modelId);
  const filteredTemplates = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return nodeTemplates.filter(template => {
      if (category !== 'all' && template.category !== category) return false;
      const text = [template.name, template.description, ...template.tags, ...template.responsibilities].join(' ').toLocaleLowerCase();
      return words.every(word => text.includes(word));
    });
  }, [query, category]);

  useEffect(() => {
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    searchRef.current?.focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); dialogRef.current?.focus(); return; }
      if (!dialogRef.current?.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.body.style.overflow = previousOverflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // App refreshes model objects regularly; keep a valid explicit choice across those refreshes.
  useEffect(() => {
    if (selectedTemplate && !compatibleModels.some(model => model.id === modelId)) {
      setModelId(suggestedTemplateModel(selectedTemplate, models, supervisorModelId)?.id ?? '');
    }
  }, [selectedTemplate, compatibleModels, modelId, models, supervisorModelId]);

  useEffect(() => {
    const content = previewRef.current?.querySelector('.node-library-preview-content');
    if (content) content.scrollTop = 0;
    if (selectedId && window.matchMedia('(max-width: 760px)').matches) {
      previewRef.current?.focus({ preventScroll: true });
    }
  }, [selectedId]);

  const selectTemplate = (template: NodeTemplate) => {
    if (selectedId !== template.id) {
      setSelectedId(template.id);
      setModelId(suggestedTemplateModel(template, models, supervisorModelId)?.id ?? '');
    }
  };
  const clearSelection = () => { setSelectedId(undefined); setModelId(''); };
  const unavailableMessage = selectedTemplate?.tools.includes('screenshot')
    ? 'This template needs an enabled model with image input support.'
    : 'Enable a model to use this template.';
  const addTemplate = () => {
    if (!selectedTemplate || !selectedModel || disabledReason) return;
    onAdd(instantiateNodeTemplate(selectedTemplate, selectedModel));
  };

  return <div className="node-library-overlay" onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); onClose(); } }}>
    <section className="node-library-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} ref={dialogRef}>
      <header className="node-library-header">
        <span className="node-library-mark"><Layers3 size={23} /></span>
        <div><span className="node-library-eyebrow">BUILD YOUR REVIEW TEAM</span><h2 id={titleId}>Node library</h2><p id={descriptionId}>Start with a focused role. Make it your own.</p></div>
        <button className="btn-icon node-library-close" type="button" aria-label="Close node library" onClick={onClose}><X size={20} /></button>
      </header>

      <div className={`node-library-body${selectedTemplate ? ' has-selection' : ''}`}>
        <div className="node-library-browse">
          <div className="node-library-filters">
            <div className="node-library-search"><Search size={18} aria-hidden="true" /><input ref={searchRef} type="search" aria-label="Search node templates" aria-controls={templatesId} placeholder="Search roles, skills, or responsibilities..." value={query} onChange={event => { setQuery(event.target.value); clearSelection(); }} />{query && <button type="button" aria-label="Clear template search" onClick={() => { setQuery(''); clearSelection(); searchRef.current?.focus(); }}><X size={16} /></button>}</div>
            <nav className="node-library-categories" aria-label="Template categories">
              <button type="button" aria-pressed={category === 'all'} onClick={() => { setCategory('all'); clearSelection(); }}>All templates<span aria-hidden="true">{nodeTemplates.length}</span></button>
              {nodeTemplateCategories.map(item => <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => { setCategory(item.id); clearSelection(); }}>{item.label}<span aria-hidden="true">{nodeTemplates.filter(template => template.category === item.id).length}</span></button>)}
            </nav>
            <p className="node-library-result-count" aria-live="polite">{filteredTemplates.length} {filteredTemplates.length === 1 ? 'template' : 'templates'}<span>Choose one to preview</span></p>
          </div>

          <div className="node-library-templates" id={templatesId}>
            {nodeTemplateCategories.map(item => {
              const templates = filteredTemplates.filter(template => template.category === item.id);
              if (!templates.length) return null;
              const ShelfIcon = categoryIcons[item.id];
              return <section className="node-library-shelf" key={item.id} aria-labelledby={`${templatesId}-${item.id}`}>
                <header className="node-library-shelf-heading"><ShelfIcon size={18} aria-hidden="true" /><div><h3 id={`${templatesId}-${item.id}`}>{item.label}<span>{templates.length}</span></h3><p>{categoryDescriptions[item.id]}</p></div></header>
                <div className="node-library-shelf-cards">{templates.map(template => {
                  const Icon = categoryIcons[template.category];
                  const model = template.id === selectedId ? selectedModel : suggestedTemplateModel(template, models, supervisorModelId);
                  return <button key={template.id} type="button" className={`node-template-card${template.id === selectedId ? ' is-selected' : ''}`} data-template-id={template.id} aria-label={`Preview ${template.name}`} aria-controls={previewId} aria-pressed={template.id === selectedId} onClick={() => selectTemplate(template)}>
                    <span className="node-template-topline"><span className={`node-template-icon category-${template.category}`}><Icon size={18} /></span><span className="node-template-category">{categoryLabel(template.category)}</span>{template.id === selectedId ? <Check size={15} className="node-template-check" /> : <ArrowRight size={15} className="node-template-arrow" />}</span>
                    <strong>{template.name}</strong><p>{template.description}</p>
                    <span className="node-template-tags">{template.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</span>
                    <span className={`node-template-model${model ? '' : ' is-unavailable'}`}>{model ? <>{model.kind === 'local' ? <Cpu size={12} /> : <Cloud size={12} />}<span>{model.name}</span><small>{model.kind === 'local' ? 'Local' : 'Cloud'}</small></> : <><Bot size={12} /><span>No compatible model</span></>}</span>
                  </button>;
                })}</div>
              </section>;
            })}
            {filteredTemplates.length === 0 && <div className="node-library-empty-results"><Search size={25} /><h3>No templates match</h3><p>Try another role or responsibility.</p><button type="button" className="btn btn-secondary" onClick={() => { setQuery(''); setCategory('all'); clearSelection(); searchRef.current?.focus(); }}>Clear filters</button></div>}
          </div>
        </div>

        <section className={`node-library-preview${selectedTemplate ? ' has-template' : ''}`} id={previewId} aria-label="Template preview" tabIndex={-1} ref={previewRef}>
          {selectedTemplate ? <>
            <button type="button" className="node-library-back" onClick={() => { clearSelection(); requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true })); }}><ArrowLeft size={16} />Back to templates</button>
            <div className="node-library-preview-content">
              <span className="node-library-eyebrow">{categoryLabel(selectedTemplate.category)} TEMPLATE</span>
              <h3>{selectedTemplate.name}</h3><p className="node-library-preview-description">{selectedTemplate.description}</p>
              <p className="node-library-edit-note">Everything in this preset is editable. After adding it, connect the node to your workflow before saving.</p>
              <div className="node-library-model-field">
                <label htmlFor={`${titleId}-model`}>Model for {selectedTemplate.name}</label>
                <select id={`${titleId}-model`} aria-label={`Model for ${selectedTemplate.name}`} value={selectedModel?.id ?? ''} disabled={compatibleModels.length === 0} onChange={event => setModelId(event.target.value)}>
                  {!selectedModel && <option value="">{compatibleModels.length ? 'Choose a model' : 'No compatible model'}</option>}
                  {compatibleModels.map(model => <option key={model.id} value={model.id}>{model.name} ({model.kind === 'local' ? 'Local' : 'Cloud'})</option>)}
                </select>
                {selectedModel && <p className="node-library-model-note">{selectedModel.kind === 'local' ? <Cpu size={13} /> : <Cloud size={13} />}<span>{selectedModel.kind === 'local' ? 'Local model' : 'Cloud model'}<code>{selectedModel.modelId}</code></span></p>}
                {compatibleModels.length === 0 && <div className="node-library-unavailable" id={availabilityId} role="status"><p>{unavailableMessage}</p><button className="btn btn-secondary btn-small" type="button" onClick={onManageModels}>Manage models<ArrowRight size={12} /></button></div>}
              </div>
              {selectedTemplate.modelPreference === 'supervisor' && <p className="node-library-supervisor-note">This is a regular review node. It uses the chosen model on every visit, separately from optional supervisor escalation limits.</p>}
              <div className="node-library-preview-section"><h4>Responsibilities</h4><ul>{selectedTemplate.responsibilities.map(responsibility => <li key={responsibility}>{responsibility}</li>)}</ul></div>
              <div className="node-library-preview-section"><h4>Tools</h4><div className="node-library-tool-list">{selectedTemplate.tools.map(tool => <span key={tool}>{tool === 'read' ? <FileSearch size={13} /> : <Eye size={13} />}{toolLabels[tool]}</span>)}</div></div>
              <details className="node-library-instructions"><summary>Persona and instructions</summary><h4>Persona</h4><p>{selectedTemplate.persona}</p><h4>Instructions</h4><p>{selectedTemplate.prompt}</p></details>
            </div>
            <div className="node-library-add-area">
              {disabledReason && <p className="node-library-disabled-reason" role="status">{disabledReason}</p>}
              {selectedModel && <div className="node-library-add-model">{selectedModel.kind === 'local' ? <Cpu size={15} /> : <Cloud size={15} />}<span title={selectedModel.name}>{selectedModel.name}</span><small>{selectedModel.kind === 'local' ? 'Local' : 'Cloud'}</small></div>}
              <button type="button" className="btn btn-primary" disabled={!selectedModel || !!disabledReason} aria-describedby={!selectedModel ? availabilityId : undefined} onClick={addTemplate}><Plus size={15} />Add to workflow</button>
              <p>Adds one independent, editable agent.</p>
            </div>
          </> : <div className="node-library-preview-placeholder"><span><Bot size={30} /></span><h3>A role for every review</h3><p>Choose a template to see its responsibilities, instructions, and compatible models.</p><div><FileSearch size={15} />Explore<ShieldCheck size={15} />Review<Eye size={15} />Observe</div></div>}
        </section>
      </div>
      <footer className="node-library-footer"><Network size={13} /><p>Decision routing is configured in Workflow settings.</p></footer>
    </section>
  </div>;
}
