import type { AppState, AgentData, AgentRole } from './types';
export const roleMeta: Record<AgentRole, {label: string; color: string; description: string}> = {
  crawler: {label:'Code crawler', color:'green', description:'Finds what needs a closer look'},
  tester: {label:'Test engineer', color:'blue', description:'Looks for the unexpected'},
  designer: {label:'UI inspector', color:'purple', description:'A fresh pair of eyes on every screen'},
  reviewer: {label:'Code reviewer', color:'orange', description:'Turns observations into clear findings'},
  coordinator: {label:'Coordinator', color:'teal', description:'Keeps the whole team in sync'},
  judge: {label:'Judge', color:'gold', description:'Compares every answer before choosing'},
  custom: {label:'Custom agent', color:'gray', description:'Your role. Your instructions.'}
};
export function makeAgent(role: AgentRole, modelId = 'claude'): AgentData {
 const meta = roleMeta[role];
 if(role==='judge') return {label:meta.label,role,color:meta.color,description:meta.description,modelId,status:'idle',tools:['read'],persona:'You are an impartial judge. Compare every candidate against the same original problem and cite evidence. Do not prefer a particular provider or a longer response.',prompt:'Compare the separate upstream answers against the original problem and your rubric. Score every candidate, explain strengths and weaknesses, and select a winner or declare a tie.',responsibilities:['Compare candidate answers','Explain scores & winner'],judgeRubric:'Correctness (40%), evidence (30%), completeness (20%), clarity (10%). Select no winner when there is a tie or insufficient evidence.'};
 return {label:meta.label,role,color:meta.color,description:meta.description,modelId,status:'idle',tools:role==='designer'?['read','screenshot']:['read'],persona:`You are a thoughtful ${meta.label.toLowerCase()}. Be specific, verify your observations, and coordinate with the staff directory.`,prompt:'Review your assigned area. Report actionable problems with file paths and evidence. Share your findings and pass useful context to the next agent.',responsibilities:[role==='designer'?'Visual quality & accessibility':role==='tester'?'Test coverage & edge cases':role==='coordinator'?'Triage & task assignments':'Code quality & correctness']};
}
const stamp = new Date().toISOString();
export const initialState: AppState = {
 workflow: {
  id:'quality-loop',name:'Codebase quality loop',description:'An always-curious team, keeping your code in good shape.',
  settings:{mode:'loop',maxCycles:3,continuous:false,maxParallel:3,intervalSeconds:10,entryNodeId:'crawler',projectPath:'',previewUrl:'http://localhost:5173',executionMode:'demo'},
  nodes:[
   {id:'crawler',type:'agent',position:{x:0,y:0},data:{...makeAgent('crawler'),label:'Scout',description:'Explore the codebase',responsibilities:['File discovery','Code smells','Potential bugs']}},
   {id:'tester',type:'agent',position:{x:330,y:0},data:{...makeAgent('tester','qwen'),label:'Test engineer',description:'Question every assumption',responsibilities:['Test coverage','Edge cases','Regression risks']}},
   {id:'designer',type:'agent',position:{x:660,y:0},data:{...makeAgent('designer'),label:'UI inspector',description:'See your app through fresh eyes',responsibilities:['Screenshots','Accessibility','Visual consistency']}},
   {id:'coordinator',type:'agent',position:{x:0,y:270},data:{...makeAgent('coordinator','qwen'),label:'Coordinator',description:'Turn findings into next steps',responsibilities:['Triage findings','Assign follow-up','Team coordination']}},
   {id:'reviewer',type:'agent',position:{x:330,y:270},data:{...makeAgent('reviewer'),label:'Code reviewer',description:'Make every finding count',responsibilities:['Verify findings','Deduplicate issues','Prioritize problems']}},
  ],
  edges:[{id:'e1',source:'crawler',target:'tester'},{id:'e2',source:'tester',target:'designer'},{id:'e3',source:'designer',target:'reviewer'},{id:'e4',source:'reviewer',target:'coordinator'},{id:'e5',source:'coordinator',target:'crawler',label:'Next cycle',data:{loop:true}}]
 },
 models:[
  {id:'claude',name:'Claude Sonnet',provider:'anthropic',modelId:'claude-sonnet-4-5',kind:'cloud',baseUrl:'',apiKeyEnv:'ANTHROPIC_API_KEY',enabled:true,contextWindow:200000,supportsImages:true},
  {id:'qwen',name:'Qwen 3 · 8B',provider:'ollama',modelId:'qwen3:8b',kind:'local',baseUrl:'http://127.0.0.1:11434/v1',apiKeyEnv:'',enabled:true,contextWindow:32768,supportsImages:false},
 ],
 findings:[], runs:[],
 messages:[{id:'welcome',from:'system',to:'all',text:'Your team is ready. Connect a codebase or run the demo to see agents discover, discuss, and hand off findings.',type:'system',createdAt:stamp}]
};
