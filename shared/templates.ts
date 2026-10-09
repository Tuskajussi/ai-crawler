import type { Workflow } from './types';
import { makeAgent } from './defaults';

/** Candidate prompts are identical; the model is the variable. */
export function comparisonWorkflow(current: Workflow, models: string[], problem: string): Workflow {
  const candidatePrompt = 'Solve the exact problem given by the upstream Problem node. Work independently. Inspect relevant code when needed. Put your complete answer, supporting evidence, and proposed approach in the output field. Do not invent issues or claim tests were executed.';
  return {
    ...current,
    id: 'model-comparison', name: 'Three minds, one problem',
    description: 'Three independent model answers, one evidence-based judgment.',
    settings: {...current.settings, entryNodeId:'problem', mode:'once', continuous:false, maxParallel:Math.max(3,current.settings.maxParallel??3)},
    nodes:[
      {id:'problem',type:'agent',position:{x:0,y:230},data:{...makeAgent('custom',models[0]),label:'The problem',description:'One shared brief for all three models',persona:'Prepare a faithful problem statement for independent solvers. Preserve the user requirements and constraints exactly. Do not solve the problem yourself.',prompt:`Put the following problem and requirements in your output for all three candidates to solve independently:\n\n${problem}`,responsibilities:['Shared problem statement','Requirements & constraints']}},
      ...models.slice(0,3).map((modelId,index)=>({id:`candidate-${index+1}`,type:'agent' as const,position:{x:340,y:index*230},data:{...makeAgent('custom',modelId),label:`Candidate ${String.fromCharCode(65+index)}`,description:'An independent answer to the same brief',persona:'You are an independent problem solver. Analyze the shared problem carefully and verify your reasoning against the code. Give your best answer without guessing what other candidates might say.',prompt:candidatePrompt,color:['green','blue','purple'][index],responsibilities:['Independent solution','Evidence & reasoning']}})),
      {id:'judge',type:'agent',position:{x:680,y:230},data:{...makeAgent('judge',models[3]||models[0]),label:'The judge',description:'Waits for all three. Weighs every answer.'}},
    ],
    edges:[
      ...[1,2,3].map(i=>({id:`fork-${i}`,source:'problem',target:`candidate-${i}`,label:i===2?'Same problem':undefined})),
      ...[1,2,3].map(i=>({id:`join-${i}`,source:`candidate-${i}`,target:'judge',label:i===2?'All answers':undefined})),
    ],
  };
}