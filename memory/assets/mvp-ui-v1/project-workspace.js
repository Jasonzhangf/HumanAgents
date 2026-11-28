// Local review fixtures. Project addresses, bindings and panes are stored only in this browser.
const projectsUI = (() => {
  const key='humanagent-project-workspace-v1', demo='HumanAgent';
  const kinds=['manager','architect','patrol','reviewer','tester','executor'];
  const colors=['#385e45','#7047a0','#84601d','#a04466','#216a88','#3c59a2'];
  const member=(name,role)=>({name,role,prompt:'',provider:'',model:''});
  const workspace={name:'工程工作区',root:'/Volumes/extension/code',bugs:''};
  let data={workspaces:[workspace],projects:[{name:demo,root:workspace.root+'/humanagent',ws:workspace.name,roles:[member('Jenny','manager'),member('Mia','tester'),member('David','executor')],panes:[],messages:[]}],current:demo,workspace:workspace.name};
  try{const raw=localStorage.getItem(key);if(raw)data=JSON.parse(raw)}catch{}
  // Keep named members and their data when opening old prototypes with editable managers.
  let normalized=false;
  for(const p of data.projects){
    const jenny=p.roles.find(r=>r.name==='Jenny');
    if(!jenny){p.roles.unshift(member('Jenny','manager'));normalized=true}
    else if(jenny.role!=='manager'){jenny.role='manager';normalized=true}
    for(const r of p.roles)if(r.name!=='Jenny'&&r.role==='manager'){r.role='待设置';normalized=true}
  }
  if(normalized)localStorage.setItem(key,JSON.stringify(data));
  const project=()=>data.projects.find(p=>p.name===data.current);
  const ws=()=>data.workspaces.find(w=>w.name===(project()?.ws??data.workspace));
  const save=()=>localStorage.setItem(key,JSON.stringify(data));
  const prefix=()=>project()?(project().storageTag??project().name):'@ceo';
  const address=(r,p=project())=>p?p.name+'.'+r.name:'Alex';
  const members=()=>project()?.roles??[];
  const owner=()=>project()?address({name:'Jenny'}):'Alex';
  const activeMember=()=>{const n=sessionStorage.getItem('ha-member');return project()?(members().some(r=>r.name===n)||n==='@memory'?n:'Jenny'):'Alex'};
  const activeAddress=()=>project()?address({name:activeMember()==='@memory'?'项目记忆':activeMember()}):'Alex';
  const scoped=key=>prefix()===demo?key:key+':'+prefix();
  const color=role=>colors[kinds.indexOf(role)]??'#526459';
  function resolve(value){for(const p of data.projects){const r=p.roles.find(r=>address(r,p)===value);if(r)return {p,r}}}
  function route(type,wanted){
    const role=wanted||({'例行巡检':'patrol','执行任务':'executor','简单问答':'manager'})[type];
    return address(members().find(m=>m.role===role)??{name:'Jenny'})
  }
  function switchTo(name,w,m='Jenny',action=''){window.dispatchEvent(new Event('project-switch'));sessionStorage.setItem('ha-member',m);sessionStorage.setItem('ha-tree-action',action);data.current=name;data.workspace=w;save();location.reload()}
  const tag=(t,text)=>{const e=document.createElement(t);if(text)e.textContent=text;return e};
  function button(text,fn){const b=tag('button',text);b.type='button';b.className='board-action';b.onclick=fn;return b}
  function field(form,label,value='',options=null){
    const l=tag('label',label),c=tag(options?'select':label==='角色提示词'?'textarea':'input');
    c.setAttribute('aria-label',label);
    if(options)for(const [v,text] of options)c.add(new Option(text,v));
    c.value=value;l.append(c);form.append(l);return c
  }
  function dialog(title){
    const d=tag('dialog');d.className='task-editor workspace-dialog';const header=tag('header');header.append(tag('h2',title),button('关闭',()=>d.close()));d.append(header);
    d.onclose=()=>d.remove();document.body.append(d);d.showModal();return d
  }
  function form(d,submit,label='保存'){
    const f=tag('form');d.append(f);const end=()=>{const b=tag('button',label);b.className='board-action primary';f.append(b)};
    f.onsubmit=e=>{e.preventDefault();submit()};return [f,end]
  }
  function invalid(c,msg){c.setCustomValidity(msg);c.reportValidity();c.oninput=()=>c.setCustomValidity('')}
  function setup(edit=null){
    const d=dialog(edit?'编辑项目':'新建项目');
    const [f,end]=form(d,()=>{
      const n=name.value.trim(),w=wname.value.trim(),r=root.value.trim(),wr=wroot.value.trim();
      if(!n||n.includes('.')||data.projects.some(p=>p!==edit&&p.name===n))return invalid(name,'请填写唯一且不含点号的项目名');
      if(!w)return invalid(wname,'请输入工作区名称');
      if(!wr.startsWith('/')||wr.split('/').includes('..'))return invalid(wroot,'请输入工作区绝对路径');
      const existing=data.workspaces.find(x=>x.name===w);
      if(existing&&existing.root!==wr)return invalid(wroot,'同名工作区已使用 '+existing.root);
      if(!r.startsWith('/')||r.split('/').includes('..')||!(r===wr||r.startsWith(wr.replace(/\/$/,'')+'/')))return invalid(root,'项目根目录须位于此工作区');
      if(!existing)data.workspaces.push({name:w,root:wr,bugs:''});
      if(edit){
        const old=edit.name,tag=edit.storageTag??old;edit.storageTag=tag;
        const rebind=a=>typeof a==='string'&&a.startsWith(old+'.')?n+a.slice(old.length):a;
        if(n!==old){for(const p of data.projects)for(const m of p.messages){m.to=rebind(m.to);m.from=rebind(m.from)}
          const k='humanagent-board-tasks-v1'+(tag===demo?'':':'+tag),rows=JSON.parse(localStorage.getItem(k)||'[]');
          if(rows.length){rows.forEach(t=>t.assignee=rebind(t.assignee));localStorage.setItem(k,JSON.stringify(rows))}
        }Object.assign(edit,{name:n,ws:w,root:r})
      }else data.projects.push({name:n,storageTag:crypto.randomUUID(),ws:w,root:r,roles:[member('Jenny','manager')],panes:[],messages:[]});switchTo(n,w)
    },edit?'保存':'创建项目');
    const wname=field(f,'工作区名称',edit?.ws??ws().name),wroot=field(f,'工作区根目录',data.workspaces.find(x=>x.name===edit?.ws)?.root??ws().root),name=field(f,'项目名称',edit?.name),root=field(f,'项目根目录',edit?.root);
    wname.onchange=()=>{const w=data.workspaces.find(x=>x.name===wname.value);if(w)wroot.value=w.root};
    if(!edit)name.oninput=()=>root.value=wroot.value.replace(/\/$/,'')+'/'+name.value.trim();end()
  }
  function editRole(r){
    const p=project(),d=dialog(r?'编辑角色':'添加角色');
    const [f,end]=form(d,()=>{
      const n=name.value.trim();if(!n||n.includes('.')||(!r&&resolve(p.name+'.'+n)))return invalid(name,'角色名称须唯一且不含点号');
      const target=r??member(n,role.value);Object.assign(target,{role:n==='Jenny'?'manager':role.value,prompt:prompt.value,provider:provider.value.trim(),model:model.value.trim()});
      if(!r)p.roles.push(target);save();d.close();mount();showProject()
    });
    const manager=r?.name==='Jenny',allowed=manager?['manager']:kinds.filter(k=>k!=='manager');
    const name=field(f,'角色名称',r?.name),role=field(f,'职责',allowed.includes(r?.role)?r.role:'executor',allowed.map(k=>[k,k])),prompt=field(f,'角色提示词',r?.prompt),provider=field(f,'Provider',r?.provider),model=field(f,'Model',r?.model);name.disabled=!!r;role.disabled=manager;
    if(!r){
      const available=data.projects.filter(x=>x.ws===p.ws&&x!==p).flatMap(x=>x.roles.map(m=>[address(m,x),m])).filter(([,m])=>!p.roles.some(h=>h.name===m.name));
      if(available.length){const preset=field(f,'从工作区角色复用','',[['','选择已有角色'],...available.map(([a])=>[a,a])]);
      preset.onchange=()=>{const m=available.find(([a])=>a===preset.value)?.[1];if(m){name.value=m.name;role.value=m.role;prompt.value=m.prompt;provider.value=m.provider;model.value=m.model}}}
    }
    end()
  }
  function send(to,text,from=owner(),sessionId=null){
    const dest=resolve(to);if(!dest||!text.trim())return false;
    const message={to,from,text:text.trim(),sessionId};dest.p.messages.push(message);const source=resolve(from)?.p;if(source&&source!==dest.p)source.messages.push(message);save();return true
  }
  function showProject(){
    document.querySelector('dialog.project-summary')?.close();
    const d=dialog(project()?.name??'Alex · CEO'),p=project(),w=ws();d.classList.add('project-summary');
    d.append(tag('p',w.name+' · '+w.root));if(p)d.append(tag('p','显式 Agent：'+owner()+'　cwd：'+p.root));
    const toolbar=tag('div');toolbar.className='board-actions';d.append(toolbar);
    toolbar.append(button('工作区 Buglist',bugs));
    if(p){
      d.append(tag('h3','项目角色'));const list=tag('div');list.className='project-roles';d.append(list);
      for(const r of p.roles){const b=button(address(r)+' · '+r.role,()=>editRole(r));b.style.borderLeft='4px solid '+color(r.role);list.append(b)}
      toolbar.append(button('编辑项目',()=>setup(p)),button('删除项目',()=>{
        if(!confirm('删除项目“'+p.name+'”及其本地示例任务、聊天和配置？'))return;
        window.dispatchEvent(new Event('project-switch'));
        const keys=['humanagent-board-tasks-v1','humanagent-explicit-topics-v1','humanagent-model-response-demo-v2','ha-schedules'].map(scoped);
        for(const k of Object.keys(localStorage))if(keys.some(x=>k===x||k.startsWith(x+':member:')||k===x+':selected-board'))localStorage.removeItem(k);
        data.projects=data.projects.filter(x=>x!==p);data.current=null;data.workspace=w.name;save();location.reload()
      }),button('添加角色',()=>editRole()),button('并行会话',panes))
    }
    const [f,end]=form(d,()=>{if(!send(to.value,body.value))return invalid(to,'没有找到该地址，或消息为空');receipt.textContent='已投递至 '+to.value;body.value=''},'发送消息');
    const to=field(f,'收件地址',p?owner():''),body=field(f,'消息');to.placeholder='project.name';const receipt=tag('output');end();f.append(receipt)
  }
  function bugs(){
    const d=dialog(ws().name+' · Vikunja Buglist'),w=ws();
    const [f,end]=form(d,()=>{try{if(!['https:','http:'].includes(new URL(url.value).protocol))throw Error()}catch{return invalid(url,'请输入有效的 Vikunja 项目 URL')}w.bugs=url.value;save();d.close();bugs()});
    const url=field(f,'Vikunja 项目 URL',w.bugs);end();
    if(w.bugs){const a=tag('a','打开工作区 Buglist ↗');a.href=w.bugs;a.target='_blank';a.rel='noopener';d.append(a)}
  }
  function panes(){
    const p=project(),d=dialog('并行会话 · '+p.name);d.classList.add('pane-dialog');
    const picker=field(d,'打开角色',p.roles[0].name,p.roles.map(r=>[r.name,address(r)])),grid=tag('div');grid.className='session-grid';
    d.append(button('＋ 打开会话',()=>{p.panes.push({id:crypto.randomUUID(),name:picker.value});save();draw()}),grid);
    function draw(){grid.replaceChildren();for(const pane of p.panes){
      const r=p.roles.find(x=>x.name===pane.name),addr=address(r),card=tag('article');card.style.borderTopColor=color(r.role);
      card.append(tag('b',addr+' · '+r.role),tag('small','会话 '+pane.id.slice(0,8)),tag('small',[r.provider,r.model].filter(Boolean).join(' / ')||'未配置模型'));
      for(const m of p.messages.filter(x=>x.to===addr||x.sessionId===pane.id))card.append(tag('p',m.from+' → '+m.to+'　'+m.text));
      const [f,end]=form(card,()=>{if(!send(to.value,body.value,addr,pane.id))return invalid(to,'请检查收件地址及消息');draw()},'发送');
      const to=field(f,'收件地址',owner()),body=field(f,'消息');end();
      card.append(button('关闭会话',()=>{p.panes=p.panes.filter(x=>x.id!==pane.id);save();draw()}));grid.append(card)
    }}draw()
  }
  function mount(){
    const rail=document.querySelector('.rail');
    rail.querySelector('.project-tree')?.remove();
    const tree=tag('div');tree.className='project-tree';
    const go=(p,m,action='')=>switchTo(p?.name??null,p?.ws??ws().name,m,action);
    const alex=button('Alex · CEO',()=>go(null,'Alex'));alex.classList.add('alex-link');tree.append(alex);
    const header=tag('header');header.append(tag('strong','项目'),button('＋ 新建',()=>setup()));tree.append(header);
    for(const p of data.projects){
      const folder=tag('details'),summary=tag('summary',p.name);folder.open=p===project();folder.append(summary);
      const directory=tag('div');directory.className='project-directory';
      directory.append(button('项目设置',()=>go(p,'Jenny','settings')));
      const roster=tag('details');roster.open=true;roster.append(tag('summary','成员'));
      for(const r of p.roles){
        const b=button(r.name+' · '+r.role+(r.name==='Jenny'?' · 显式 Agent':''),()=>go(p,r.name));b.style.borderLeft='3px solid '+color(r.role);
        b.setAttribute('aria-current',String(p===project()&&activeMember()===r.name));roster.append(b)
      }
      directory.append(roster,button('项目记忆 Agent',()=>go(p,'@memory')),button('Buglist ↗',()=>go(p,'Jenny','bugs')));folder.append(directory);tree.append(folder)
    }
    rail.insertBefore(tree,rail.children[1]);
    document.querySelector('.topic-bar .crumb').textContent=activeAddress()+(project()?' · cwd '+project().root:' · CEO');
  }
  function pendingAction(){const action=sessionStorage.getItem('ha-tree-action');sessionStorage.removeItem('ha-tree-action');if(action==='settings')showProject();if(action==='bugs')bugs()}
  return {project,ws,scoped,route,owner,members,address,color,mount,showProject,send,activeMember,activeAddress,pendingAction,demo:prefix()===demo}
})();
