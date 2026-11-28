(() => {
  const board = $('board-view');
  const storage = agentSession.board.key;
  const roles = {
    interaction: ['显式 Agent','整理用户需求，转达问题与结果。'],
    orchestration: ['隐式 Agent（编排）','安排执行，核对结果，按需发起审查。'],
    execution: ['执行 Agent','接收分派并交回结果和证据。'],
    review: ['审查 Agent','按指定标准只读核对证据，交回审查结论。'],
    memory: ['记忆 Agent','异步整理授权历史，形成记忆候选。']
  };
  const runtimeNodes = [
    {id:'rt-ui-01',role:'interaction'},
    {id:'rt-mem-01',role:'memory',parent:'rt-ui-01',edge:'memory'},
    {id:'rt-plan-07',role:'orchestration',parent:'rt-ui-01',edge:'task'},
    {id:'rt-mem-07',role:'memory',parent:'rt-plan-07',edge:'memory'}
  ];
  let debugMode=false;
  const seeds = [
    ['quote','采购报价比较','比较两份报价，给出最低价、供应商及出处。','执行任务','随执行更新',''],
    ['patrol','报价目录巡检','按计划检查报价目录，并汇报文件变化。','例行巡检','待执行','quote'],
    ['report','整理采购汇总表','收到比较结果后整理供应商、价格及出处。','执行任务','待执行','quote'],
    ['format','确定交付清单格式','已商定使用表格列出交付项、负责人及依据。','简单问答','已完成','']
  ];
  let tasks=projectsUI.demo?seeds.map(([id,title,goal,type,state,parent])=>({id,title,goal,type,state,parent})):[];
  tasks=agentSession.board.load(tasks);
  if(!agentSession.project)tasks.forEach(t=>{if(t.assignee==='CEO')t.assignee='Alex'});
  const project=projectsUI.project(), scopeLabel=project?'项目任务 · '+project.name:'CEO 通用任务';
  const selectionKey=storage+':selected-board';
  const boards=project?[...new Set([...projectsUI.members().map(r=>projectsUI.address(r)),agentSession.address])]:['Alex'];
  const remembered=localStorage.getItem(selectionKey);
  let group='当前任务', taskId=null, selectedRole=null, chat=true, roleBoard=agentSession.address, moduleName=null;
  const assignee=t=>t.assignee||projectsUI.route(t.type);
  if(tasks.some(t=>!t.assignee)){tasks.forEach(t=>{if(!t.assignee)t.assignee=assignee(t)});persist()}
  function persist(){agentSession.board.save(tasks)}
  function btn(text,cls,click){const b=node('button',cls,text);b.type='button';b.onclick=click;return b}
  function status(t){
    if(t.state!=='随执行更新')return t.state;
    const run=topics[0].active;return !run?'已完成':run.phase===6?'等你回答':run.phase===9?'自动重试中':'执行中'
  }
  function done(t){return status(t)==='已完成'}
  function badge(t){return node('span','board-status '+(status(t)==='待执行'?'pending':/回答|重试/.test(status(t))?'wait':''),status(t))}
  function show(id=null,tab=group){
    document.body.classList.remove('nav-open');
    moduleName='board';
    group=tab;taskId=id;selectedRole=null;chat=false;detail=null;togglePanel(false);
    $('chat-view').hidden=false;board.hidden=false;paint();board.scrollTop=0
  }
  function openChat(topicIndex=selected){document.body.classList.remove('nav-open');chat=true;moduleName=null;board.hidden=true;$('chat-view').hidden=false;switchTopic(topicIndex);paint()}
  function row(t){
    const b=btn('','board-row',()=>show(t.id));const title=node('span','row-name',t.title);
    title.append(node('small','',t.type));b.append(title,node('span','board-owner',assignee(t)),badge(t),node('span','','›'));return b
  }
  function editor(t=null){
    const d=document.createElement('dialog');d.className='task-editor';
    const form=node('form',''),name=node('input',''),goal=node('textarea',''),type=node('select',''),state=node('select','');
    form.append(node('h2','',t?'编辑任务':'新建任务'),node('p','',scopeLabel));
    function field(label,control){const l=node('label','',label);control.setAttribute('aria-label',label);l.append(control);form.append(l)}
    name.required=true;name.maxLength=100;name.value=t?.title??'';goal.value=t?.goal??'';
    for(const v of ['执行任务','例行巡检','简单问答'])type.add(new Option(v,v));
    for(const v of [...(t?.state==='随执行更新'?['随执行更新']:[]),'待执行','执行中','已完成'])state.add(new Option(v,v));
    type.value=t?.type??'执行任务';state.value=t?.state??'待执行';
    field('任务名称',name);field('目标',goal);field('任务类型',type);field('状态',state);
    const binding=node('select','');if(project)binding.add(new Option('自动分派',''));
    boards.forEach(a=>binding.add(new Option(a,a)));binding.value=t?.assignee??roleBoard;field('角色任务板',binding);
    const work=node('select','');
    for(const [v,l] of [['manager','协调'],['architect','设计'],['patrol','巡检'],['reviewer','审查'],['tester','测试'],['executor','执行']])work.add(new Option(l,v));
    work.value=t?.duty??'executor';if(project)field('工作职责',work);type.onchange=()=>work.value=type.value==='例行巡检'?'patrol':type.value==='简单问答'?'manager':'executor';
    const actions=node('div','board-actions'),save=node('button','board-action primary','保存');save.type='submit';
    actions.append(btn('取消','board-action',()=>d.close()),save);form.append(actions);d.append(form);document.body.append(d);
    d.onclose=()=>d.remove();name.oninput=()=>name.setCustomValidity('');
    form.onsubmit=e=>{e.preventDefault();if(!name.value.trim()){name.setCustomValidity('请输入任务名称');name.reportValidity();return}
      const value=t??{id:crypto.randomUUID(),parent:''};
      Object.assign(value,{title:name.value.trim(),goal:goal.value.trim(),type:type.value,state:state.value,duty:work.value,assignee:binding.value||projectsUI.route(type.value,work.value)});if(!t)tasks.push(value);
      persist();d.close();show(assignee(value)===roleBoard?value.id:null,done(value)?'历史任务':'当前任务')
    };d.showModal()
  }
  function remove(t){
    if(!confirm('删除“'+t.title+'”？关联子任务将保留。'))return;
    tasks=tasks.filter(x=>x!==t);tasks.forEach(x=>{if(x.parent===t.id)x.parent=''});persist();show()
  }
  function roleMap(inner,task){
    const scope=task??tasks.find(t=>t.id==='quote');
    if(!scope)return;
    inner.append(node('h2','',task?'任务运行实例':scope.title+' · 运行实例'));
    if(!['quote','format'].includes(scope.id)){
      inner.append(node('p','empty','本任务尚无已登记的 runtime。'));return
    }
    const root=runtimeNodes[0];
    const nodes=scope.id==='format'?runtimeNodes.slice(0,2):runtimeNodes;
    const branches=(parent,edge)=>nodes.filter(n=>n.parent===parent.id&&n.edge===edge);
    function chip(n){
      const b=btn('','runtime-node',()=>{selectedRole=n.id;paint()});
      b.dataset.runtime=n.id;b.setAttribute('aria-pressed',String((selectedRole??root.id)===n.id));
      b.append(node('strong','',roles[n.role][0]),node('code','',n.id));return b
    }
    function pair(n){
      const group=node('div','runtime-pair');group.append(chip(n));
      for(const memory of branches(n,'memory')){
        group.append(node('div','memory-edge','↓ 专属记忆'),chip(memory))
      }
      return group
    }
    const graph=node('div','runtime-graph');graph.append(pair(root));
    for(const n of branches(root,'task')){
      graph.append(node('div','task-edge','任务投递 →'),pair(n))
    }
    inner.append(graph);
    const n=nodes.find(n=>n.id===selectedRole)??root;
    const owner=nodes.find(parent=>parent.id===n.parent);
    const info=node('section','board-thread runtime-detail'),head=node('div','board-hero');
    head.append(node('h3','',roles[n.role][0]+' · '+n.id));
    const toggle=btn(debugMode?'退出 Debug':'Debug','board-action',()=>{debugMode=!debugMode;paint()});toggle.setAttribute('aria-pressed',String(debugMode));head.append(toggle);info.append(head);
    if(debugMode){
      info.append(node('small','kicker','Debug 预留 · 示例布局'));
      info.append(node('h4','','角色提示词'),node('p','',roles[n.role][1]),node('h4','','当前上下文栈'));
      const stack=node('ol','context-stack');
      const layers=n.role==='memory'?['所属实例 · '+owner.id,'授权历史与记忆整理范围','本轮记忆候选与冲突']:n.role==='interaction'?['显式交互角色与职责','前序对话语义摘要','最新用户消息与待答问题']:['隐式编排角色与职责','本任务目标与约束','已完成步骤与回传记录','当前执行轮次'];
      layers.forEach(label=>stack.append(node('li','',label)));info.append(stack)
    }else{
      info.append(node('p','',n.role==='memory'?'所属 runtime：'+owner.id+' · 尚无记忆会话记录':roles[n.role][1]));
      if(n.role==='interaction')info.append(btn(scope.id==='format'?'打开关联 Topic':'打开主会话','board-action',()=>{
        let i=0;if(scope.id==='format'){i=topics.findIndex(t=>t.id==='format');if(i<0)i=sideTopic('交付格式讨论','format',[record('交付清单用什么格式比较好？','建议用表格列出交付项、负责人及依据。',formatAnswer)])}
        openChat(i)
      }));
      if(n.role==='orchestration'){
        const turn=topics[0].active;
        info.append(node('b','','本任务 · '+status(scope)));
        if(turn){info.append(node('p','',phases[turn.phase][0]));content(turn,info)}
        else info.append(node('p','',topics[0].history.findLast(x=>x.phase===8)?.summary??'本轮已结束。'))
      }
    }
    inner.append(info)
  }
  function overview(inner){
    const hero=node('div','board-hero');hero.append(node('h1','',project?roleBoard+' 的任务板':'CEO 通用任务板'),btn('＋ 新建任务','board-action primary',()=>editor()));inner.append(hero);
    const roster=node('div','board-tabs');roster.append(node('small','',scopeLabel));
    inner.append(roster);const owned=agentSession.board.owned(tasks);
    const tabs=node('div','board-tabs');
    for(const tab of ['当前任务','历史任务']){
      const list=owned.filter(t=>done(t)===(tab==='历史任务')),b=btn(tab+' · '+list.length,'board-action',()=>show(null,tab));b.setAttribute('aria-pressed',String(group===tab));tabs.append(b)
    }inner.append(tabs);
    const list=owned.filter(t=>done(t)===(group==='历史任务')),container=node('div','board-section');list.forEach(t=>container.append(row(t)));
    if(!list.length)container.append(node('p','empty','暂无'+group));inner.append(container);
    const sample=list.find(t=>t.id==='quote');if(sample)roleMap(inner,sample)
  }
  function taskPage(t,inner){
    const hero=node('div','board-hero');hero.append(node('h1','',t.title),badge(t));inner.append(hero,node('p','',t.goal));
    inner.append(node('p','',scopeLabel+'　/　'+assignee(t)+' 的任务板'));const actions=node('div','board-actions');actions.append(btn('编辑','board-action',()=>editor(t)),btn('删除','board-action danger',()=>remove(t)));inner.append(actions);
    inner.append(node('h2','','任务主线'));const chain=node('div','board-chain');
    const phases=t.type==='简单问答'?['收到问题','直接回答']:['整理需求','投递与执行','回传结果'];
    const now=done(t)?phases.length-1:status(t)==='待执行'?0:1;
    phases.forEach((v,i)=>{if(i)chain.append(node('span','','→'));chain.append(node('span','chain-step '+(i===now?'now':i<now?'done':''),v))});inner.append(chain);
    const linked=tasks.filter(x=>x.parent===t.id||x.id===t.parent);
    if(linked.length){inner.append(node('h2','','关联任务'));const group=node('div','board-section');linked.forEach(x=>group.append(row(x)));inner.append(group)}
    roleMap(inner,t)
  }
  function paint(){
    if(chat)return;
    if(moduleName==='schedules'){scheduleView();return}
    const bar=node('header','board-bar'),inner=node('div','board-inner'),t=tasks.find(x=>x.id===taskId);
    bar.append(t?btn('← '+group,'board-action',()=>show()):node('span','kicker',agentSession.address+' / Board'),btn('关闭抽屉','board-action',()=>openChat()));
    if(t)taskPage(t,inner);else overview(inner);board.replaceChildren(bar,inner)
  }
  function scheduleView(){
    const bar=node('header','board-bar'),inner=node('div','board-inner');bar.append(node('b','',agentSession.address+' / 定时任务'),btn('关闭抽屉','board-action',()=>openChat()));
    function edit(item){
      const d=document.createElement('dialog'),f=node('form','');d.className='task-editor';
      const title=node('input',''),interval=node('input','');title.required=true;interval.type='number';interval.min='1';interval.required=true;
      title.value=item?.title??'';interval.value=item?.minutes??30;
      for(const [label,control] of [['任务名称',title],['间隔（分钟）',interval]]){const l=node('label','',label);l.append(control);f.append(l)}
      f.append(btn('取消','board-action',()=>d.close()),node('button','board-action primary','保存'));d.append(f);document.body.append(d);d.onclose=()=>d.remove();
      f.onsubmit=e=>{e.preventDefault();if(!title.value.trim())return;agentSession.schedules.put({id:item?.id??crypto.randomUUID(),title:title.value.trim(),minutes:Number(interval.value)});d.close();scheduleView()};d.showModal()
    }
    inner.append(btn('＋ 新建定时任务','board-action primary',()=>edit(null)));
    for(const s of agentSession.schedules.list()){const r=node('div','board-thread');r.append(node('strong','',s.title),node('p','','每 '+s.minutes+' 分钟'),btn('编辑','board-action',()=>edit(s)),btn('删除','board-action',()=>{if(confirm('删除这项定时任务？')){agentSession.schedules.remove(s.id);scheduleView()}}));inner.append(r)}
    board.replaceChildren(bar,inner)
  }
  const commands={board:['任务板',()=>show()],schedules:['定时任务',()=>{detail=null;togglePanel(false);chat=false;moduleName='schedules';board.hidden=false;scheduleView()}]};
  agentSession.modules.forEach(k=>{const [label,action]=commands[k];$('module-buttons').append(btn(label,'toggle',action))});
  const menu=btn('☰','mobile-nav-toggle',()=>{const open=document.body.classList.toggle('nav-open');menu.setAttribute('aria-expanded',String(open))});
  menu.setAttribute('aria-label','工作区导航');document.body.append(menu);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.body.classList.remove('nav-open');menu.setAttribute('aria-expanded','false')}});
  window.refreshBoard=()=>{menu.setAttribute('aria-expanded',String(document.body.classList.contains('nav-open')));if(moduleName==='board')paint()};
  board.hidden=true;projectsUI.pendingAction()
})()
