import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, applyEdgeChanges, addEdge, MarkerType, type NodeProps, type Node, type Connection, type NodeChange, type EdgeChange, type ReactFlowInstance } from '@xyflow/react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, CircleHelp, Cloud, Code2, Copy, Cpu, Eye, FileSearch, Flag, FolderGit2, GitBranch, Grip, Layers3, LayoutGrid, ListChecks, LoaderCircle, Maximize, Menu, MessageSquare, MoreHorizontal, Network, Play, Plus, Radio, Repeat2, Save, ScanEye, Search, Settings2, ShieldCheck, Sparkles, Square, Terminal, Trash2, Users, Workflow as WorkflowIcon, X } from 'lucide-react';
import type { AppState, AgentData, AgentRole, Workflow, WorkflowNode, ModelConfig, Finding, Message, RuntimeStatus } from '../shared/types';
import { initialState, roleMeta } from '../shared/defaults';
import { FindingsPanel, MessagesPanel, StaffPanel, ModelsPanel, RunsPanel, SettingsModal } from './Panels';
import { NodeLibrary } from './NodeLibrary';
import { KnowledgePanel } from './KnowledgePanel';
import { ReliabilityPanel } from './ReliabilityPanel';

type Page = 'builder' | 'findings' | 'messages' | 'staff' | 'models' | 'knowledge' | 'reliability' | 'runs';
const roleIcons = {crawler:FileSearch,tester:ListChecks,designer:ScanEye,reviewer:ShieldCheck,coordinator:Network,custom:Bot};
async function request(path: string, method = 'GET', body?: unknown) {
 const res = await fetch(`/api${path}`, {method, headers: {'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
 const data = await res.json();
 if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
 return data;
}
function AgentNode({data, selected}: NodeProps<Node<AgentData>>) {
 const Icon = roleIcons[data.role];
 return <div className={`agent-node ${selected?'is-selected':''} ${data.status==='running'?'is-running':''}`}>
  <Handle type="target" position={Position.Left} />
  {data.isEntry === true && <div className="entry-label"><span/> START HERE</div>}
  <div className="node-top"><span className={`agent-avatar ${data.color}`}><Icon size={20}/></span><span className={`node-role ${data.color}`}>{roleMeta[data.role].label}</span><Grip className="node-grip" size={15}/></div>
  <div className="node-name">{data.label}<span className={`status-dot ${data.status}`} title={data.status}/></div>
  <p className="node-description">{data.description}</p>
  <div className="node-bottom"><span>{data.modelKind==='local'?<Cpu size={12}/>:<Cloud size={12}/>} {String(data.modelName || 'Choose a model')}</span>{data.tools.includes('screenshot')?<Eye size={13}/>:<Code2 size={13}/>}</div>
  <Handle type="source" position={Position.Right}/>
 </div>;
}
const nodeTypes = {agent: AgentNode};

function useMediaQuery(query:string) {
 const [matches,setMatches]=useState(()=>window.matchMedia(query).matches);
 useEffect(()=>{const media=window.matchMedia(query);const update=()=>setMatches(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[query]);
 return matches;
}

// Drawers share the same keyboard and focus behavior as the workspace dialogs.
function useOverlayFocus(active:boolean,onClose:()=>void,returnFocus?:()=>HTMLElement|null) {
 const ref=useRef<HTMLElement>(null);
 const closeRef=useRef(onClose);
 closeRef.current=onClose;
 useEffect(()=>{
  const panel=ref.current;
  if(!active||!panel)return;
  const previous=returnFocus?.()??(document.activeElement instanceof HTMLElement?document.activeElement:null);
  const overflow=document.body.style.overflow;
  document.body.style.overflow='hidden';
  const focusable=()=>Array.from(panel.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(el=>el.getClientRects().length>0&&!el.closest('[inert]'));
  const frame=requestAnimationFrame(()=>(focusable()[0]??panel).focus({preventScroll:true}));
  const onKey=(event:KeyboardEvent)=>{
   if(event.key==='Escape'){event.preventDefault();closeRef.current();}
   if(event.key==='Tab'){
    const items=focusable();const first=items[0];const last=items.at(-1);
    if(!first){event.preventDefault();panel.focus();}
    else if(event.shiftKey&&(document.activeElement===first||!panel.contains(document.activeElement))){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||!panel.contains(document.activeElement))){event.preventDefault();first.focus();}
   }
  };
  document.addEventListener('keydown',onKey);
  return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',onKey);document.body.style.overflow=overflow;const target=returnFocus?.()??previous;if(target?.isConnected)target.focus({preventScroll:true});};
 },[active]);
 return ref;
}

export default function App() {
 const [state,setState] = useState<AppState>(initialState);
 const [page,setPage] = useState<Page>('builder');
 const compactInspector=useMediaQuery('(max-width: 1100px)');
 const compactNavigation=useMediaQuery('(max-width: 760px)');
 const [navigationOpen,setNavigationOpen]=useState(false);
 const [selected,setSelected] = useState<string|null>(()=>window.matchMedia('(max-width: 1100px)').matches?null:'crawler');
 const [nodeMeasurements,setNodeMeasurements] = useState<Record<string,{width:number;height:number}>>({});
 const [dirty,setDirty] = useState(false);
 const dirtyRef = useRef(false);
 const [ready,setReady] = useState(false);
 const [runtime,setRuntime] = useState<RuntimeStatus|null>(null);
 const [error,setError] = useState('');
 const [notice,setNotice] = useState('');
 const [busy,setBusy] = useState(false);
 const [addOpen,setAddOpen] = useState(false);
 const [settingsOpen,setSettingsOpen] = useState(false);
 const [helpOpen,setHelpOpen] = useState(false);
 const modalOpener=useRef<HTMLElement|null>(null);
 const rememberModalOpener=()=>{if(!addOpen&&!settingsOpen&&!helpOpen)modalOpener.current=compactNavigation&&navigationOpen?document.querySelector<HTMLElement>('.navigation-toggle'):document.activeElement instanceof HTMLElement?document.activeElement:null;};
 const openLibrary=()=>{rememberModalOpener();setAddOpen(true);};
 const openSettings=()=>{rememberModalOpener();setSettingsOpen(true);};
 const openHelp=()=>{rememberModalOpener();setHelpOpen(true);};
 const [inspectorTab,setInspectorTab] = useState<'setup'|'prompt'>('setup');
 const navigationRef=useOverlayFocus(compactNavigation&&navigationOpen,()=>setNavigationOpen(false),()=>document.querySelector<HTMLElement>('.navigation-toggle'));
 const helpRef=useOverlayFocus(helpOpen,()=>setHelpOpen(false),()=>modalOpener.current);
 useEffect(()=>{if(!addOpen&&!settingsOpen&&!helpOpen){if(modalOpener.current?.isConnected)modalOpener.current.focus({preventScroll:true});modalOpener.current=null;}},[addOpen,settingsOpen,helpOpen]);
 const navigate=(next:Page)=>{setPage(next);setNavigationOpen(false);};
 useEffect(()=>{if(!compactNavigation)setNavigationOpen(false);},[compactNavigation]);
 useEffect(()=>{if(compactInspector)setSelected(null);},[compactInspector]);
 useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 const flowRef = useRef<{fitView:(options:{padding?:number;duration?:number})=>Promise<boolean>}|null>(null);
 const refresh = useCallback(async () => {
  const [next,health] = await Promise.all([request('/state') as Promise<AppState>,(request('/health') as Promise<RuntimeStatus>).catch(()=>null)]);
  setState(prev => dirtyRef.current ? {...next,workflow:{...prev.workflow,nodes:prev.workflow.nodes.map(n=>({...n,data:{...n.data,status:next.workflow.nodes.find(v=>v.id===n.id)?.data.status||'idle'}}))}} : next);
  setRuntime(health);
  setReady(true);
 },[]);
 useEffect(()=> {refresh().catch(e=>setError(`Cannot reach the local server. ${e.message}`)); const timer=setInterval(()=>refresh().catch(()=>{}),1500); return ()=>clearInterval(timer);},[refresh]);
 useEffect(()=> {if(!notice)return;const timer=setTimeout(()=>setNotice(''),3500);return()=>clearTimeout(timer);},[notice]);
 const editWorkflow = useCallback((updater: (workflow:Workflow)=>Workflow)=>{dirtyRef.current=true;setDirty(true);setState(prev=>({...prev,workflow:updater(prev.workflow)}));},[]);
 const updateAgent = (patch:Partial<AgentData>) => {if(!editingLocked)editWorkflow(w=>({...w,nodes:w.nodes.map(n=>n.id===selected?{...n,data:{...n.data,...patch}}:n)}));};
 const mutate = async (path:string,method:string,body?:unknown) => {setError('');try {await request(path,method,body);await refresh();}catch(e){setError((e as Error).message);throw e;}};
 const saveWorkflow = async (workflow=state.workflow) => {await request('/workflow','PUT',workflow);dirtyRef.current=false;setDirty(false);await refresh();};
 const safeAction = async (fn:()=>Promise<void>,message?:string) => {setBusy(true);setError('');try{await fn();if(message)setNotice(message);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const run = () => safeAction(async()=>{await saveWorkflow();await mutate('/runs','POST',{mode:state.workflow.settings.executionMode});},`${state.workflow.settings.executionMode==='demo'?'Demo':'Workflow'} started`);
 const activeRun = state.runs.find(r=>r.status==='running');
 const editingLocked=!ready||busy||!!activeRun;
 const activeNodeIds = activeRun?.activeNodeIds ?? (activeRun?.activeNodeId ? [activeRun.activeNodeId] : []);
 const activeLabels = activeNodeIds.map(id=>state.workflow.nodes.find(node=>node.id===id)?.data.label ?? id);
 const agent=state.workflow.nodes.find(n=>n.id===selected);
 const inspectorRef=useOverlayFocus(compactInspector&&page==='builder'&&!!agent&&!addOpen&&!settingsOpen&&!helpOpen&&!navigationOpen,()=>setSelected(null),()=>selected?document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(selected)}"]`):null);
 useEffect(()=>{if(ready&&selected&&!agent)setSelected(null);},[ready,selected,agent]);
 const model=state.models.find(m=>m.id===agent?.data.modelId);
 const findingCount=state.findings.filter(f=>f.status!=='resolved').length;
 const nav: {id:Page;label:string;icon:typeof WorkflowIcon;group:string;count?:number}[] = [
  {id:'builder',label:'Workflow builder',icon:WorkflowIcon,group:'Workspace'},{id:'staff',label:'Your team',icon:Users,group:'Workspace'},{id:'messages',label:'Team messages',icon:MessageSquare,group:'Workspace'},
  {id:'models',label:'Models',icon:Cpu,group:'Resources'},{id:'knowledge',label:'Knowledge',icon:Layers3,group:'Resources'},
  {id:'findings',label:'Findings',icon:Flag,group:'Insights',count:findingCount},{id:'reliability',label:'Tool reliability',icon:ShieldCheck,group:'Insights'},{id:'runs',label:'Run history',icon:Radio,group:'Insights'},
 ];
 const onNodesChange=useCallback((changes:NodeChange<Node<AgentData>>[])=>{
  if(changes.some(c=>c.type==='dimensions'))setNodeMeasurements(current=>{const next={...current};for(const change of changes)if(change.type==='dimensions'&&change.dimensions)next[change.id]=change.dimensions;return next;});
  if(!editingLocked&&changes.some(c=>c.type==='position'||c.type==='remove'))editWorkflow(w=>({...w,nodes:applyNodeChanges(changes.filter(c=>c.type!=='dimensions'),w.nodes) as WorkflowNode[],edges:w.edges.filter(e=>!changes.some(c=>c.type==='remove'&&(c.id===e.source||c.id===e.target)))}));
 },[editWorkflow,editingLocked]);
 const onEdgesChange=useCallback((changes:EdgeChange[])=>{if(!editingLocked&&changes.some(c=>c.type==='remove'))editWorkflow(w=>({...w,edges:applyEdgeChanges(changes,w.edges)}));},[editWorkflow,editingLocked]);
 const onConnect=useCallback((connection:Connection)=>{if(!editingLocked)editWorkflow(w=>({...w,edges:addEdge({...connection,id:`edge-${crypto.randomUUID()}`,type:'smoothstep'},w.edges)}));},[editWorkflow,editingLocked]);
 const libraryDisabledReason = !ready ? 'Wait for your workspace to load before adding an agent.' : activeRun ? 'Stop the current run before adding an agent.' : busy ? 'Wait for the current action to finish before adding an agent.' : state.workflow.nodes.length >= 100 ? 'A workflow can contain up to 100 agents. Remove an agent before adding another.' : undefined;
 const addAgent=(data:AgentData)=>{
  if(libraryDisabledReason){setError(libraryDisabledReason);return;}
  const chosenModel=state.models.find(m=>m.id===data.modelId&&m.enabled);
  if(!chosenModel||(data.tools.includes('screenshot')&&chosenModel.supportsImages!==true)){setError('Choose an enabled model with the capabilities this agent needs.');return;}
  const id=crypto.randomUUID();
  editWorkflow(w=>({...w,nodes:[...w.nodes,{id,type:'agent',position:{x:330*(w.nodes.length%3),y:270*Math.floor(w.nodes.length/3)},data}],settings:{...w.settings,entryNodeId:w.nodes.length?w.settings.entryNodeId:id}}));setSelected(id);setInspectorTab('setup');setAddOpen(false);setNotice(`${data.label} added. Connect it to your workflow, then save.`);setTimeout(()=>flowRef.current?.fitView({padding:0.18,duration:300}),100);
 };
 const removeAgent=()=>{if(!selected||editingLocked)return;const id=selected;editWorkflow(w=>{const nodes=w.nodes.filter(n=>n.id!==id);return {...w,nodes,edges:w.edges.filter(e=>e.source!==id&&e.target!==id),settings:{...w.settings,entryNodeId:w.settings.entryNodeId===id?(nodes[0]?.id||''):w.settings.entryNodeId}};});setSelected(null);};
 const duplicateAgent=()=>{if(!agent||editingLocked||state.workflow.nodes.length>=100)return;const id=crypto.randomUUID();editWorkflow(w=>({...w,nodes:[...w.nodes,{...agent,id,position:{x:agent.position.x+70,y:agent.position.y+190},data:{...agent.data,label:`${agent.data.label} copy`,status:'idle'}}]}));setSelected(id);};
 const renderedNodes = state.workflow.nodes.map(n=>({...n,ariaRole:'button' as const,ariaLabel:`${n.data.label}. Open agent settings.`,selected:n.id===selected,measured:nodeMeasurements[n.id],data:{...n.data,isEntry:n.id===state.workflow.settings.entryNodeId,modelName:state.models.find(m=>m.id===n.data.modelId)?.name,modelKind:state.models.find(m=>m.id===n.data.modelId)?.kind}}));
 const renderedEdges = state.workflow.edges.map(e=>({...e,type:'smoothstep',animated:!!activeRun,style:{stroke:e.data?.loop?'#86a494':'#bdc9c0',strokeWidth:1.6,...(e.data?.loop?{strokeDasharray:'5 5'}:{})},labelStyle:{fill:'#71877a',fontSize:10,fontWeight:600},labelBgStyle:{fill:'#f4f6f2'},markerEnd:{type:MarkerType.ArrowClosed,width:14,height:14,color:'#9aafa1'}}));

 return <div className="app-shell">
  <a className="skip-link" href="#workspace-content">Skip to workspace</a>
  {compactNavigation&&navigationOpen&&<div className="navigation-scrim" onClick={()=>setNavigationOpen(false)} aria-hidden="true"/>}
  <aside id="workspace-navigation" ref={navigationRef} tabIndex={-1} className={`sidebar ${navigationOpen?'is-open':''}`} role={compactNavigation&&navigationOpen?'dialog':undefined} aria-modal={compactNavigation&&navigationOpen?true:undefined} aria-label="Workspace navigation" inert={compactNavigation&&!navigationOpen||helpOpen||settingsOpen||addOpen||compactInspector&&page==='builder'&&!!agent&&!navigationOpen}>
   <div className="sidebar-heading"><a href="#" className="brand" onClick={e=>{e.preventDefault();navigate('builder');}}><span className="brand-mark"><Repeat2 size={23}/></span>crawlspace<span className="brand-dot">.</span></a><button className="btn-icon navigation-close" aria-label="Close navigation" onClick={()=>setNavigationOpen(false)}><X size={20}/></button></div>
   <div className="workspace-switch"><span className="workspace-avatar">P</span><div>Personal workspace<small>Local environment</small></div></div>
   <nav aria-label="Main navigation">{['Workspace','Resources','Insights'].map(group=><div className="nav-group" key={group}><div className="nav-section-label">{group}</div>{nav.filter(item=>item.group===group).map(item=><button key={item.id} className={`nav-item ${page===item.id?'active':''}`} aria-current={page===item.id?'page':undefined} onClick={()=>navigate(item.id)}><item.icon size={18}/><span>{item.label}</span>{!!item.count&&<span className="nav-count">{item.count}</span>}{item.id==='runs'&&activeRun&&<span className="live-dot"/>}</button>)}</div>)}</nav>
   <div className="sidebar-bottom"><button className="nav-item" onClick={()=>{setNavigationOpen(false);openHelp();}}><CircleHelp size={18}/><span>Getting started</span><ArrowUpRight size={14}/></button><button className="profile" aria-label="Open workflow settings" onClick={()=>{setNavigationOpen(false);openSettings();}}><span className="profile-avatar">Y</span><span>Workspace settings<small>Running on your machine</small></span><Settings2 size={17}/></button></div>
  </aside>
  <div className="workspace-main" inert={navigationOpen&&compactNavigation||helpOpen||settingsOpen||addOpen}>
   <header className="topbar" inert={compactInspector&&page==='builder'&&!!agent}><div className="topbar-location"><button className="btn-icon navigation-toggle" aria-label="Open navigation" aria-expanded={navigationOpen} aria-controls="workspace-navigation" onClick={()=>setNavigationOpen(true)}><Menu size={21}/></button><div className="breadcrumb"><Layers3 size={17}/><span>Workspace</span><ChevronRight size={14}/><strong>{nav.find(n=>n.id===page)?.label}</strong></div></div><div className="topbar-right"><span className="local-indicator"><span/>Local workspace</span><button className="btn-icon" aria-label="Help" aria-haspopup="dialog" onClick={()=>openHelp()}><CircleHelp size={20}/></button><span className="topbar-avatar" aria-hidden="true">Y</span></div></header>
   {error&&<div className="error-banner" role="alert"><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
   {notice&&<div className="toast" role="status"><Check size={16}/>{notice}</div>}
   {page==='builder'?<main id="workspace-content" tabIndex={-1} className="builder-page">
    <div className="builder-heading" inert={compactInspector&&!!agent}><div><div className="eyebrow"><span/> WORKSPACE</div><h1>Workflow builder</h1><p>Arrange your agents, choose their models, and connect the work.</p></div><button className="btn btn-secondary" onClick={()=>openSettings()}><Settings2 size={15}/> Workflow settings</button></div>
    <div className="workflow-strip" inert={compactInspector&&!!agent}><div className="workflow-identity"><span className="workflow-symbol"><GitBranch size={20}/></span><div><input aria-label="Workflow name" disabled={editingLocked} value={state.workflow.name} onChange={e=>editWorkflow(w=>({...w,name:e.target.value}))}/><span>{state.workflow.settings.executionMode==='demo'?'Demo workspace':state.workflow.settings.projectPath||'No codebase connected'}<span className="dot-separator">·</span>{state.workflow.nodes.length} agents</span></div></div><div className="workflow-actions"><button className={`save-button ${dirty?'unsaved':''}`} disabled={!dirty||busy||!ready||!!activeRun} onClick={()=>safeAction(()=>saveWorkflow(),'Workflow saved')}><Save size={14}/>{dirty?'Save changes':'All changes saved'}</button>{activeRun?<button className="btn btn-stop" disabled={busy} onClick={()=>safeAction(()=>mutate('/runs/stop','POST'),'Run stopped')}><Square size={13} fill="currentColor"/>Stop run</button>:<button className="btn btn-primary" disabled={busy||!ready} onClick={run}>{busy?<LoaderCircle size={15} className="spin"/>:<Play size={14} fill="currentColor"/>}{state.workflow.settings.executionMode==='demo'?'Run demo':'Run workflow'}</button>}</div></div>
    {activeRun&&<div className="run-status-banner" role="status"><Radio size={15}/><span>Cycle {activeRun.cycle} · {activeLabels.length>1?`${activeLabels.length} agents working`:activeLabels[0]||'Starting team'}</span></div>}
    <section className="builder-workspace">
     <div className="canvas-area" inert={compactInspector&&!!agent}>
      <div className="canvas-toolbar"><div className="canvas-tabs"><button className="selected"><WorkflowIcon size={14}/>Builder</button><button onClick={()=>setPage('runs')}><Radio size={14}/>Runs{state.runs.length>0&&<span>{state.runs.length}</span>}</button></div><div className="canvas-tools"><button className={`loop-mode ${state.workflow.settings.mode==='loop'?'enabled':''}`} title="Toggle looping" aria-label="Loop workflow" aria-pressed={state.workflow.settings.mode==='loop'} disabled={editingLocked} onClick={()=>editWorkflow(w=>({...w,settings:{...w.settings,mode:w.settings.mode==='loop'?'once':'loop'}}))}><Repeat2 size={14}/>{state.workflow.settings.mode==='loop'?(state.workflow.settings.continuous?'Loop · Until stopped':`Loop · ${state.workflow.settings.maxCycles} cycles`):'Run once'}<span className={`toggle ${state.workflow.settings.mode==='loop'?'on':''}`}/></button><button className="btn add-node-button" aria-haspopup="dialog" title="Browse the node library" onClick={()=>openLibrary()}><Plus size={15}/>Add agent</button></div></div>
      <div className="flow-canvas"><ReactFlow onKeyDownCapture={event=>{if(event.key!=='Enter'&&event.key!==' ')return;const node=event.target instanceof Element?event.target.closest<HTMLElement>('.react-flow__node'):null;if(node?.dataset.id){event.preventDefault();event.stopPropagation();setSelected(node.dataset.id);}}} nodes={renderedNodes} edges={renderedEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,node)=>setSelected(node.id)} onPaneClick={()=>{setSelected(null);setAddOpen(false);}} onInit={instance=>{flowRef.current=instance;}} fitView fitViewOptions={{padding:0.15,maxZoom:1,...(compactNavigation?{nodes:[{id:state.workflow.settings.entryNodeId}]}:{})}} minZoom={0.3} maxZoom={1.5} deleteKeyCode={addOpen||settingsOpen||helpOpen||editingLocked||compactInspector&&!!agent||compactNavigation&&navigationOpen?null:['Backspace','Delete']} nodesDraggable={!editingLocked} nodesConnectable={!editingLocked} elementsSelectable colorMode="light"><Background color="#dce3da" gap={22} size={1}/><Controls showInteractive={false}/><MiniMap nodeColor={n=>n.selected?'#4c7b60':'#c9d5ca'} maskColor="rgba(245,247,243,0.8)" pannable zoomable/></ReactFlow><div className="canvas-caption" title={activeLabels.join(', ')}><span className="caption-dot"/> {activeRun?`Cycle ${activeRun.cycle} · ${activeLabels.length>1?`${activeLabels.length} agents working`:activeLabels[0]||'Starting team'}`:'Connect ideas. Build your loop.'}</div></div>
      <div className="team-activity"><div className="activity-title"><span><MessageSquare size={15}/>Team activity<span className="quiet-badge">Shared context</span></span><button onClick={()=>setPage('messages')}>Open messages<ArrowUpRight size={13}/></button></div><div className="activity-items">{state.messages.slice(-2).reverse().map(msg=>{const sender=state.workflow.nodes.find(n=>n.id===msg.from);const Icon=sender?roleIcons[sender.data.role]:Sparkles;return <div className="activity-item" key={msg.id}><span className={`activity-avatar ${sender?.data.color||'green'}`}><Icon size={14}/></span><div><div><strong>{sender?.data.label||(msg.from==='you'?'You':'Crawlspace')}</strong><span>{msg.type==='assignment'?'handed off a task':msg.type==='system'?'workspace update':'shared an update'}</span><time>{new Date(msg.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><p>{msg.text}</p></div></div>;})}</div></div>
     </div>
     <div className={`inspector-scrim ${agent?'is-open':''}`} onClick={()=>setSelected(null)} aria-hidden="true"/>
     <aside ref={inspectorRef} tabIndex={-1} className={`inspector ${agent?'is-open':''}`} role={compactInspector&&agent?'dialog':undefined} aria-modal={compactInspector&&agent?true:undefined} aria-label={agent?`${agent.data.label} settings`:'Agent settings'}>
      {agent?<><div className="inspector-heading"><span className={`agent-avatar ${agent.data.color}`}>{(()=>{const Icon=roleIcons[agent.data.role];return <Icon size={22}/>;})()}</span><div><strong>{agent.data.label}</strong><span>{roleMeta[agent.data.role].label}</span></div><button className="btn-icon" onClick={()=>setSelected(null)} aria-label="Close agent settings"><X size={16}/></button></div><div className="inspector-tabs"><button className={inspectorTab==='setup'?'active':''} onClick={()=>setInspectorTab('setup')}>Configuration</button><button className={inspectorTab==='prompt'?'active':''} onClick={()=>setInspectorTab('prompt')}>Instructions</button></div><fieldset className="inspector-body" disabled={editingLocked}>{activeRun&&<p className="inspector-lock-note" role="status">Stop the run to change agent settings.</p>}
       {inspectorTab==='setup'?<><div className="inspector-section"><div className="section-caption">THE BASICS</div><label className="field">Agent name<input value={agent.data.label} onChange={e=>updateAgent({label:e.target.value})}/></label><label className="field">What does this agent do?<input value={agent.data.description} onChange={e=>updateAgent({description:e.target.value})}/></label></div><div className="inspector-section"><div className="section-caption">INTELLIGENCE</div><label className="field">Model<select value={agent.data.modelId} onChange={e=>updateAgent({modelId:e.target.value})}>{state.models.filter(m=>m.enabled||m.id===agent.data.modelId).map(m=><option value={m.id} key={m.id}>{m.name} · {m.kind}</option>)}</select></label><div className="model-hint">{model?.kind==='local'?<Cpu size={13}/>:<Cloud size={13}/>}<span>{model?.kind==='local'?'Runs on your machine':'Cloud model'}<small>{model?.kind==='local'?'Private by default. Your hardware.':model?.authMethod==='chatgpt'?'Uses your connected ChatGPT account.':'Credentials stay in server environment variables.'}</small></span><button onClick={()=>setPage('models')} aria-label="Manage models"><ArrowUpRight size={14}/></button></div></div><div className="inspector-section"><div className="section-caption">RESPONSIBILITIES <span>VASTUUALUEET</span></div><label className="field"><span className="sr-only">Responsibilities, one per line</span><textarea className="responsibilities-input" rows={3} value={agent.data.responsibilities.join('\n')} onChange={e=>updateAgent({responsibilities:e.target.value.split('\n')})}/></label><p className="field-help">Shared with the team so everyone knows who owns what.</p></div><div className="inspector-section"><div className="section-caption">CAPABILITIES</div><div className="capability"><span><FileSearch size={15}/>Read codebase</span><span className="capability-check"><Check size={11}/></span></div><label className="capability"><span><Eye size={15}/>Capture UI screenshots</span><input type="checkbox" checked={agent.data.tools.includes('screenshot')} onChange={e=>updateAgent({tools:e.target.checked?['read','screenshot']:['read']})}/></label></div><button className="prompt-shortcut" onClick={()=>setInspectorTab('prompt')}><Terminal size={16}/><span>Give your agent a persona<small>Personality, context & instructions</small></span><ArrowRight size={15}/></button></>:<><div className="inspector-section"><div className="section-caption">PERSONA</div><label className="field">Who is this agent?<textarea rows={7} value={agent.data.persona} onChange={e=>updateAgent({persona:e.target.value})}/></label><p className="field-help">Describe its expertise, approach, and how it works with others.</p></div><div className="inspector-section"><div className="section-caption">NODE PROMPT</div><label className="field">Instructions for every visit<textarea rows={9} value={agent.data.prompt} onChange={e=>updateAgent({prompt:e.target.value})}/></label><p className="field-help">The agent also receives the staff directory, recent messages, and existing findings.</p></div></>}
       </fieldset><div className="inspector-footer"><button disabled={editingLocked||state.workflow.nodes.length>=100} onClick={duplicateAgent}><Copy size={13}/>Duplicate</button><button className="danger-text" disabled={editingLocked} onClick={removeAgent}><Trash2 size={13}/>Remove</button></div></>:<div className="inspector-empty"><span className="agent-avatar green"><Settings2 size={24}/></span><h3>A place for every detail.</h3><p>Select an agent to shape its role, choose its model, and write its instructions.</p><button className="btn btn-secondary" onClick={()=>openLibrary()}><Plus size={15}/>Add an agent</button></div>}
     </aside>
    </section>
    <footer className="builder-footer"><span><span className={`health-dot ${ready?'ready':''}`}/>{ready?'Local runner ready':'Connecting to local runner'}</span><span><Users size={12}/>{state.workflow.nodes.length} agents<span className="dot-separator">·</span><Cpu size={12}/>{state.models.length} configured models</span><span>Made for the long run<Repeat2 size={12}/></span></footer>
   </main>:<main id="workspace-content" tabIndex={-1} className="content-page">{page==='findings'?<FindingsPanel state={state} onStatus={(id,status)=>void safeAction(()=>mutate(`/findings/${id}`,'PATCH',{status}))}/>:page==='messages'?<MessagesPanel state={state} onSend={async(text,to,type)=>{await mutate('/messages','POST',{text,to,type,from:'you'});}}/>:page==='staff'?<StaffPanel state={state} onSelect={id=>{setSelected(id);setPage('builder');}}/>:page==='models'?<ModelsPanel state={state} runtime={runtime} onSave={async models=>{await mutate('/models','PUT',models);setNotice('Model settings saved');}}/>:page==='knowledge'?<KnowledgePanel/>:page==='reliability'?<ReliabilityPanel state={state}/>:<RunsPanel state={state}/>}</main>}
  </div>
  {addOpen&&<NodeLibrary models={state.models} supervisorModelId={state.workflow.settings.supervisorModelId} disabledReason={libraryDisabledReason} onAdd={addAgent} onClose={()=>setAddOpen(false)} onManageModels={()=>{setAddOpen(false);setPage('models');}}/>}
  {settingsOpen&&<SettingsModal workflow={state.workflow} models={state.models} runtime={runtime} onClose={()=>setSettingsOpen(false)} onSave={async workflow=>{try{await saveWorkflow(workflow);setSettingsOpen(false);setNotice('Workflow settings saved');}catch(e){setError((e as Error).message);throw e;}}}/>}
  {helpOpen&&<div className="modal-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setHelpOpen(false);}}><section ref={helpRef} tabIndex={-1} className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-header"><span className="agent-avatar green"><Sparkles size={22}/></span><button className="btn-icon" aria-label="Close help" onClick={()=>setHelpOpen(false)}><X size={18}/></button></div><h2 id="help-title">Meet your next little team.</h2><p>Crawlspace gives curious agents a shared place to review your code and pass their discoveries along.</p><div className="help-step"><span>01</span><div><strong>Shape the workflow</strong><p>Add agents and connect their handles. Select an agent to edit its model, persona, responsibilities, and prompt.</p></div></div><div className="help-step"><span>02</span><div><strong>Try a demo</strong><p>Run the built-in team without credentials. Demo findings are clearly labeled, and your messages stay on this machine.</p></div></div><div className="help-step"><span>03</span><div><strong>Connect your codebase</strong><p>The Pi coding runtime is included. Add your own model in Models, set any required credential in the server environment before starting or restarting it, and choose Pi in workflow settings. Agents review files and capture a local UI using read-only tools.</p></div></div><button className="btn btn-primary" onClick={()=>{setHelpOpen(false);openSettings();}}>Set up my workspace<ArrowRight size={15}/></button></section></div>}
 </div>;
}
