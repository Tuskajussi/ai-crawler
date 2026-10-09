import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, applyEdgeChanges, addEdge, MarkerType, type NodeProps, type Node, type Connection, type NodeChange, type EdgeChange, type ReactFlowInstance } from '@xyflow/react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, CircleHelp, Cloud, Code2, Copy, Cpu, Eye, FileSearch, Flag, FolderGit2, GitBranch, Grip, Layers3, LayoutGrid, ListChecks, LoaderCircle, Maximize, MessageSquare, MoreHorizontal, Network, Play, Plus, Radio, Repeat2, Save, ScanEye, Search, Settings2, ShieldCheck, Sparkles, Square, Terminal, Trash2, Users, Workflow as WorkflowIcon, X } from 'lucide-react';
import type { AppState, AgentData, AgentRole, Workflow, WorkflowNode, ModelConfig, Finding, Message } from '../shared/types';
import { initialState, makeAgent, roleMeta } from '../shared/defaults';
import { FindingsPanel, MessagesPanel, StaffPanel, ModelsPanel, RunsPanel, SettingsModal } from './Panels';

type Page = 'builder' | 'findings' | 'messages' | 'staff' | 'models' | 'runs';
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

export default function App() {
 const [state,setState] = useState<AppState>(initialState);
 const [page,setPage] = useState<Page>('builder');
 const [selected,setSelected] = useState<string|null>('crawler');
 const [dirty,setDirty] = useState(false);
 const dirtyRef = useRef(false);
 const [ready,setReady] = useState(false);
 const [error,setError] = useState('');
 const [notice,setNotice] = useState('');
 const [busy,setBusy] = useState(false);
 const [addOpen,setAddOpen] = useState(false);
 const [settingsOpen,setSettingsOpen] = useState(false);
 const [helpOpen,setHelpOpen] = useState(false);
 const [inspectorTab,setInspectorTab] = useState<'setup'|'prompt'>('setup');
 const flowRef = useRef<{fitView:(options:{padding?:number;duration?:number})=>Promise<boolean>}|null>(null);
 const refresh = useCallback(async () => {
  const next = await request('/state') as AppState;
  setState(prev => dirtyRef.current ? {...next,workflow:{...prev.workflow,nodes:prev.workflow.nodes.map(n=>({...n,data:{...n.data,status:next.workflow.nodes.find(v=>v.id===n.id)?.data.status||'idle'}}))}} : next);
  setReady(true);
 },[]);
 useEffect(()=> {refresh().catch(e=>setError(`Cannot reach the local server. ${e.message}`)); const timer=setInterval(()=>refresh().catch(()=>{}),1500); return ()=>clearInterval(timer);},[refresh]);
 useEffect(()=> {if(!notice)return;const timer=setTimeout(()=>setNotice(''),3500);return()=>clearTimeout(timer);},[notice]);
 const editWorkflow = useCallback((updater: (workflow:Workflow)=>Workflow)=>{dirtyRef.current=true;setDirty(true);setState(prev=>({...prev,workflow:updater(prev.workflow)}));},[]);
 const updateAgent = (patch:Partial<AgentData>) => editWorkflow(w=>({...w,nodes:w.nodes.map(n=>n.id===selected?{...n,data:{...n.data,...patch}}:n)}));
 const mutate = async (path:string,method:string,body?:unknown) => {setError('');try {await request(path,method,body);await refresh();}catch(e){setError((e as Error).message);throw e;}};
 const saveWorkflow = async (workflow=state.workflow) => {await request('/workflow','PUT',workflow);dirtyRef.current=false;setDirty(false);await refresh();};
 const safeAction = async (fn:()=>Promise<void>,message?:string) => {setBusy(true);setError('');try{await fn();if(message)setNotice(message);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const run = () => safeAction(async()=>{await saveWorkflow();await mutate('/runs','POST',{mode:state.workflow.settings.executionMode});},`${state.workflow.settings.executionMode==='demo'?'Demo':'Workflow'} started`);
 const activeRun = state.runs.find(r=>r.status==='running');
 const agent=state.workflow.nodes.find(n=>n.id===selected);
 const model=state.models.find(m=>m.id===agent?.data.modelId);
 const findingCount=state.findings.filter(f=>f.status!=='resolved').length;
 const nav: {id:Page;label:string;icon:typeof WorkflowIcon;count?:number}[] = [
  {id:'builder',label:'Workflow builder',icon:WorkflowIcon},{id:'findings',label:'Findings',icon:Flag,count:findingCount},
  {id:'messages',label:'Team messages',icon:MessageSquare},{id:'staff',label:'Your team',icon:Users},{id:'models',label:'Models',icon:Cpu},
 ];
 const onNodesChange=useCallback((changes:NodeChange<Node<AgentData>>[])=>{
  if(changes.some(c=>c.type==='position'||c.type==='remove'))editWorkflow(w=>({...w,nodes:applyNodeChanges(changes,w.nodes) as WorkflowNode[],edges:w.edges.filter(e=>!changes.some(c=>c.type==='remove'&&(c.id===e.source||c.id===e.target)))}));
 },[editWorkflow]);
 const onEdgesChange=useCallback((changes:EdgeChange[])=>{if(changes.some(c=>c.type==='remove'))editWorkflow(w=>({...w,edges:applyEdgeChanges(changes,w.edges)}));},[editWorkflow]);
 const onConnect=useCallback((connection:Connection)=>editWorkflow(w=>({...w,edges:addEdge({...connection,id:`edge-${crypto.randomUUID()}`,type:'smoothstep'},w.edges)})),[editWorkflow]);
 const addAgent=(role:AgentRole)=>{
  const id=crypto.randomUUID();const data=makeAgent(role,state.models[0]?.id||'');
  editWorkflow(w=>({...w,nodes:[...w.nodes,{id,type:'agent',position:{x:330*(w.nodes.length%3),y:270*Math.floor(w.nodes.length/3)},data}]}));setSelected(id);setAddOpen(false);setTimeout(()=>flowRef.current?.fitView({padding:0.18,duration:300}),100);
 };
 const removeAgent=()=>{if(!selected)return;const id=selected;editWorkflow(w=>{const nodes=w.nodes.filter(n=>n.id!==id);return {...w,nodes,edges:w.edges.filter(e=>e.source!==id&&e.target!==id),settings:{...w.settings,entryNodeId:w.settings.entryNodeId===id?(nodes[0]?.id||''):w.settings.entryNodeId}};});setSelected(null);};
 const duplicateAgent=()=>{if(!agent)return;const id=crypto.randomUUID();editWorkflow(w=>({...w,nodes:[...w.nodes,{...agent,id,position:{x:agent.position.x+70,y:agent.position.y+190},data:{...agent.data,label:`${agent.data.label} copy`,status:'idle'}}]}));setSelected(id);};
 const renderedNodes = state.workflow.nodes.map(n=>({...n,selected:n.id===selected,data:{...n.data,isEntry:n.id===state.workflow.settings.entryNodeId,modelName:state.models.find(m=>m.id===n.data.modelId)?.name,modelKind:state.models.find(m=>m.id===n.data.modelId)?.kind}}));
 const renderedEdges = state.workflow.edges.map(e=>({...e,type:'smoothstep',animated:!!activeRun,style:{stroke:e.data?.loop?'#86a494':'#bdc9c0',strokeWidth:1.6,...(e.data?.loop?{strokeDasharray:'5 5'}:{})},labelStyle:{fill:'#71877a',fontSize:10,fontWeight:600},labelBgStyle:{fill:'#f4f6f2'},markerEnd:{type:MarkerType.ArrowClosed,width:14,height:14,color:'#9aafa1'}}));

 return <div className="app-shell">
  <aside className="sidebar">
   <a href="#" className="brand" onClick={e=>{e.preventDefault();setPage('builder');}}><span className="brand-mark"><Repeat2 size={23}/></span>crawlspace<span className="brand-dot">.</span></a>
   <div className="workspace-switch"><span className="workspace-avatar">P</span><div>Personal workspace<small>Local environment</small></div><ChevronDown size={13}/></div>
   <div className="nav-section-label">WORKSPACE</div>
   <nav>{nav.map(item=><button key={item.id} className={`nav-item ${page===item.id?'active':''}`} onClick={()=>setPage(item.id)}><item.icon size={17}/><span>{item.label}</span>{!!item.count&&<span className="nav-count">{item.count}</span>}</button>)}</nav>
   <div className="nav-divider"/><button className={`nav-item ${page==='runs'?'active':''}`} onClick={()=>setPage('runs')}><Radio size={17}/><span>Run history</span>{activeRun&&<span className="live-dot"/>}</button>
   <div className="sidebar-bottom"><div className="small-note"><span className="small-note-icon"><Sparkles size={18}/></span><strong>A little team.<br/>A better codebase.</strong><p>Give your agents a purpose.<br/>Let curiosity do the rest.</p></div><button className="nav-item" onClick={()=>setHelpOpen(true)}><CircleHelp size={17}/><span>Getting started</span><ArrowUpRight size={13}/></button><button className="profile" onClick={()=>setSettingsOpen(true)}><span className="profile-avatar">Y</span><span>Your workspace<small>Running on your machine</small></span><Settings2 size={15}/></button></div>
  </aside>
  <div className="workspace-main">
   <header className="topbar"><div className="breadcrumb"><Layers3 size={16}/><span>Workspace</span><ChevronRight size={12}/><strong>{page==='builder'?'Workflow builder':page==='staff'?'Your team':page==='runs'?'Run history':nav.find(n=>n.id===page)?.label}</strong></div><div className="topbar-right"><span className="local-indicator"><span/>Local workspace</span><button className="btn-icon" aria-label="Help" onClick={()=>setHelpOpen(true)}><CircleHelp size={17}/></button><span className="topbar-avatar">Y</span></div></header>
   {error&&<div className="error-banner" role="alert"><span>{error}</span><button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
   {notice&&<div className="toast" role="status"><Check size={16}/>{notice}</div>}
   {page==='builder'?<main className="builder-page">
    <div className="builder-heading"><div><div className="eyebrow"><span/> YOUR AUTONOMOUS WORKSPACE</div><h1>Code gets better with company<span>.</span></h1><p>Build a team of agents. Give them a direction. Keep improving.</p></div><button className="btn btn-secondary" onClick={()=>setSettingsOpen(true)}><Settings2 size={15}/> Workflow settings</button></div>
    <div className="workflow-strip"><div className="workflow-identity"><span className="workflow-symbol"><GitBranch size={20}/></span><div><input aria-label="Workflow name" value={state.workflow.name} onChange={e=>editWorkflow(w=>({...w,name:e.target.value}))}/><span>{state.workflow.settings.executionMode==='demo'?'Demo workspace':state.workflow.settings.projectPath||'No codebase connected'}<span className="dot-separator">·</span>{state.workflow.nodes.length} agents</span></div></div><div className="workflow-actions"><button className={`save-button ${dirty?'unsaved':''}`} disabled={!dirty||busy||!ready||!!activeRun} onClick={()=>safeAction(()=>saveWorkflow(),'Workflow saved')}><Save size={14}/>{dirty?'Save changes':'All changes saved'}</button>{activeRun?<button className="btn btn-stop" disabled={busy} onClick={()=>safeAction(()=>mutate('/runs/stop','POST'),'Run stopped')}><Square size={13} fill="currentColor"/>Stop run</button>:<button className="btn btn-primary" disabled={busy||!ready} onClick={run}>{busy?<LoaderCircle size={15} className="spin"/>:<Play size={14} fill="currentColor"/>}{state.workflow.settings.executionMode==='demo'?'Run demo':'Run workflow'}</button>}</div></div>
    <section className="builder-workspace">
     <div className="canvas-area">
      <div className="canvas-toolbar"><div className="canvas-tabs"><button className="selected"><WorkflowIcon size={14}/>Builder</button><button onClick={()=>setPage('runs')}><Radio size={14}/>Runs{state.runs.length>0&&<span>{state.runs.length}</span>}</button></div><div className="canvas-tools"><button className={`loop-mode ${state.workflow.settings.mode==='loop'?'enabled':''}`} title="Toggle looping" onClick={()=>editWorkflow(w=>({...w,settings:{...w.settings,mode:w.settings.mode==='loop'?'once':'loop'}}))}><Repeat2 size={14}/>{state.workflow.settings.mode==='loop'?`Loop · ${state.workflow.settings.maxCycles} cycles`:'Run once'}<span className={`toggle ${state.workflow.settings.mode==='loop'?'on':''}`}/></button><div className="add-node-wrap"><button className="btn add-node-button" onClick={()=>setAddOpen(!addOpen)}><Plus size={15}/>Add agent</button>{addOpen&&<div className="add-node-menu"><span>ADD TO YOUR TEAM</span>{Object.entries(roleMeta).map(([key,meta])=>{const Icon=roleIcons[key as AgentRole];return <button key={key} onClick={()=>addAgent(key as AgentRole)}><span className={`agent-avatar ${meta.color}`}><Icon size={16}/></span><span><strong>{meta.label}</strong><small>{meta.description}</small></span><Plus size={13}/></button>;})}</div>}</div></div></div>
      <div className="flow-canvas"><ReactFlow nodes={renderedNodes} edges={renderedEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,node)=>setSelected(node.id)} onPaneClick={()=>{setSelected(null);setAddOpen(false);}} onInit={instance=>{flowRef.current=instance;}} fitView fitViewOptions={{padding:0.15,maxZoom:1}} minZoom={0.3} maxZoom={1.5} deleteKeyCode={['Backspace','Delete']} nodesDraggable={!activeRun} nodesConnectable={!activeRun} elementsSelectable colorMode="light"><Background color="#dce3da" gap={22} size={1}/><Controls showInteractive={false}/><MiniMap nodeColor={n=>n.selected?'#4c7b60':'#c9d5ca'} maskColor="rgba(245,247,243,0.8)" pannable zoomable/></ReactFlow><div className="canvas-caption"><span className="caption-dot"/> {activeRun?`Cycle ${activeRun.cycle} · ${state.workflow.nodes.find(n=>n.id===activeRun.activeNodeId)?.data.label||'Starting team'}`:'Connect ideas. Build your loop.'}</div></div>
      <div className="team-activity"><div className="activity-title"><span><MessageSquare size={15}/>Team activity<span className="quiet-badge">Shared context</span></span><button onClick={()=>setPage('messages')}>Open messages<ArrowUpRight size={13}/></button></div><div className="activity-items">{state.messages.slice(-2).reverse().map(msg=>{const sender=state.workflow.nodes.find(n=>n.id===msg.from);const Icon=sender?roleIcons[sender.data.role]:Sparkles;return <div className="activity-item" key={msg.id}><span className={`activity-avatar ${sender?.data.color||'green'}`}><Icon size={14}/></span><div><div><strong>{sender?.data.label||(msg.from==='you'?'You':'Crawlspace')}</strong><span>{msg.type==='assignment'?'handed off a task':msg.type==='system'?'workspace update':'shared an update'}</span><time>{new Date(msg.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><p>{msg.text}</p></div></div>;})}</div></div>
     </div>
     <aside className="inspector">
      {agent?<><div className="inspector-heading"><span className={`agent-avatar ${agent.data.color}`}>{(()=>{const Icon=roleIcons[agent.data.role];return <Icon size={22}/>;})()}</span><div><strong>{agent.data.label}</strong><span>{roleMeta[agent.data.role].label}</span></div><button className="btn-icon" onClick={()=>setSelected(null)} aria-label="Close agent settings"><X size={16}/></button></div><div className="inspector-tabs"><button className={inspectorTab==='setup'?'active':''} onClick={()=>setInspectorTab('setup')}>Configuration</button><button className={inspectorTab==='prompt'?'active':''} onClick={()=>setInspectorTab('prompt')}>Instructions</button></div><div className="inspector-body">
       {inspectorTab==='setup'?<><div className="inspector-section"><div className="section-caption">THE BASICS</div><label className="field">Agent name<input value={agent.data.label} onChange={e=>updateAgent({label:e.target.value})}/></label><label className="field">What does this agent do?<input value={agent.data.description} onChange={e=>updateAgent({description:e.target.value})}/></label></div><div className="inspector-section"><div className="section-caption">INTELLIGENCE</div><label className="field">Model<select value={agent.data.modelId} onChange={e=>updateAgent({modelId:e.target.value})}>{state.models.filter(m=>m.enabled||m.id===agent.data.modelId).map(m=><option value={m.id} key={m.id}>{m.name} · {m.kind}</option>)}</select></label><div className="model-hint">{model?.kind==='local'?<Cpu size={13}/>:<Cloud size={13}/>}<span>{model?.kind==='local'?'Runs on your machine':'Cloud model'}<small>{model?.kind==='local'?'Private by default. Your hardware.':'Credentials stay in server environment variables.'}</small></span><button onClick={()=>setPage('models')} aria-label="Manage models"><ArrowUpRight size={14}/></button></div></div><div className="inspector-section"><div className="section-caption">RESPONSIBILITIES <span>VASTUUALUEET</span></div><label className="field"><span className="sr-only">Responsibilities, one per line</span><textarea className="responsibilities-input" rows={3} value={agent.data.responsibilities.join('\n')} onChange={e=>updateAgent({responsibilities:e.target.value.split('\n')})}/></label><p className="field-help">Shared with the team so everyone knows who owns what.</p></div><div className="inspector-section"><div className="section-caption">CAPABILITIES</div><div className="capability"><span><FileSearch size={15}/>Read codebase</span><span className="capability-check"><Check size={11}/></span></div><label className="capability"><span><Eye size={15}/>Capture UI screenshots</span><input type="checkbox" checked={agent.data.tools.includes('screenshot')} onChange={e=>updateAgent({tools:e.target.checked?['read','screenshot']:['read']})}/></label></div><button className="prompt-shortcut" onClick={()=>setInspectorTab('prompt')}><Terminal size={16}/><span>Give your agent a persona<small>Personality, context & instructions</small></span><ArrowRight size={15}/></button></>:<><div className="inspector-section"><div className="section-caption">PERSONA</div><label className="field">Who is this agent?<textarea rows={7} value={agent.data.persona} onChange={e=>updateAgent({persona:e.target.value})}/></label><p className="field-help">Describe its expertise, approach, and how it works with others.</p></div><div className="inspector-section"><div className="section-caption">NODE PROMPT</div><label className="field">Instructions for every visit<textarea rows={9} value={agent.data.prompt} onChange={e=>updateAgent({prompt:e.target.value})}/></label><p className="field-help">The agent also receives the staff directory, recent messages, and existing findings.</p></div></>}
       </div><div className="inspector-footer"><button onClick={duplicateAgent}><Copy size={13}/>Duplicate</button><button className="danger-text" onClick={removeAgent}><Trash2 size={13}/>Remove</button></div></>:<div className="inspector-empty"><span className="agent-avatar green"><Settings2 size={24}/></span><h3>A place for every detail.</h3><p>Select an agent to shape its role, choose its model, and write its instructions.</p><button className="btn btn-secondary" onClick={()=>setAddOpen(true)}><Plus size={15}/>Add an agent</button></div>}
     </aside>
    </section>
    <footer className="builder-footer"><span><span className={`health-dot ${ready?'ready':''}`}/>{ready?'Local runner ready':'Connecting to local runner'}</span><span><Users size={12}/>{state.workflow.nodes.length} agents<span className="dot-separator">·</span><Cpu size={12}/>{state.models.length} configured models</span><span>Made for the long run<Repeat2 size={12}/></span></footer>
   </main>:<main className="content-page">{page==='findings'?<FindingsPanel state={state} onStatus={(id,status)=>void safeAction(()=>mutate(`/findings/${id}`,'PATCH',{status}))}/>:page==='messages'?<MessagesPanel state={state} onSend={async(text,to,type)=>{await mutate('/messages','POST',{text,to,type,from:'you'});}}/>:page==='staff'?<StaffPanel state={state} onSelect={id=>{setSelected(id);setPage('builder');}}/>:page==='models'?<ModelsPanel state={state} onSave={async models=>{await mutate('/models','PUT',models);setNotice('Model settings saved');}}/>:<RunsPanel state={state}/>}</main>}
  </div>
  {settingsOpen&&<SettingsModal workflow={state.workflow} onClose={()=>setSettingsOpen(false)} onSave={async workflow=>{try{await saveWorkflow(workflow);setSettingsOpen(false);setNotice('Workflow settings saved');}catch(e){setError((e as Error).message);throw e;}}}/>}
  {helpOpen&&<div className="modal-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setHelpOpen(false);}}><section className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-header"><span className="agent-avatar green"><Sparkles size={22}/></span><button className="btn-icon" aria-label="Close help" onClick={()=>setHelpOpen(false)}><X size={18}/></button></div><h2 id="help-title">Meet your next little team.</h2><p>Crawlspace gives curious agents a shared place to review your code and pass their discoveries along.</p><div className="help-step"><span>01</span><div><strong>Shape the workflow</strong><p>Add agents and connect their handles. Select an agent to edit its model, persona, responsibilities, and prompt.</p></div></div><div className="help-step"><span>02</span><div><strong>Try a demo</strong><p>Run the built-in team without credentials. Demo findings are clearly labeled, and your messages stay on this machine.</p></div></div><div className="help-step"><span>03</span><div><strong>Connect your codebase</strong><p>Install the Pi SDK, configure a model, and choose Pi in workflow settings. Agents review files and capture a local UI using read-only tools.</p></div></div><button className="btn btn-primary" onClick={()=>{setHelpOpen(false);setSettingsOpen(true);}}>Set up my workspace<ArrowRight size={15}/></button></section></div>}
 </div>;
}
