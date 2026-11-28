// Shared session capabilities for the static prototype. This layer has no DOM dependencies.
function createAgentSession(projects,storage) {
  const project=projects.project(), member=projects.activeMember(), address=projects.activeAddress();
  const explicit=!project||member==='Jenny';
  const key=name=>projects.scoped(name)+(explicit?'':':member:'+encodeURIComponent(member));
  const read=(k,otherwise)=>{const data=storage.getItem(k);return data===null?otherwise:JSON.parse(data)};
  const write=(k,value)=>storage.setItem(k,JSON.stringify(value));
  const scheduleKey=key('ha-schedules'), boardKey=projects.scoped('humanagent-board-tasks-v1');
  return {
    project:project?.name??null,member,address,explicit,cwd:project?.root??null,
    modules:['board','schedules'],topicsKey:key('humanagent-explicit-topics-v1'),
    board:{key:boardKey,load:initial=>read(boardKey,initial),save:rows=>write(boardKey,rows),
      owned:rows=>rows.filter(t=>t.assignee===address)},
    schedules:{
      list:()=>read(scheduleKey,[]),
      put(item){const items=read(scheduleKey,[]),i=items.findIndex(x=>x.id===item.id);if(i<0)items.push(item);else items[i]=item;write(scheduleKey,items)},
      remove(id){write(scheduleKey,read(scheduleKey,[]).filter(x=>x.id!==id))}
    }
  }
}
const agentSession=createAgentSession(projectsUI,localStorage);
