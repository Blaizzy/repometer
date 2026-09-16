import {githubAccess} from './github-access.mjs?v=12';

export function mountGitHubAccess(){
  if(document.getElementById('github-access-dialog'))return;
  const button=document.createElement('button');button.type='button';button.className='github-access-button';button.dataset.githubAccess='';button.textContent='Connect GitHub';
  document.querySelector('.workspace-nav').append(button);
  const dialog=document.createElement('dialog');dialog.id='github-access-dialog';dialog.className='github-access-dialog';dialog.setAttribute('aria-labelledby','github-access-title');
  dialog.innerHTML=`<div class="github-access-heading"><h2 id="github-access-title">GitHub access</h2><button type="button" class="github-access-close" aria-label="Close GitHub access">×</button></div>
    <p>Sign in with your GitHub account for a higher request limit.</p>
    <div id="github-connection-status" class="github-connection-status" role="status"></div>
    <button type="button" id="github-sign-in" class="github-sign-in">Sign in with GitHub <span aria-hidden="true">↗</span></button>
    <p id="github-sign-in-help" class="github-access-help">Approve on GitHub and return to this page. Your credentials stay on the server, and this counter reads public repositories only.</p>
    <button type="button" id="github-disconnect" class="github-disconnect" hidden>Disconnect GitHub</button>
    <p id="github-access-error" class="error" role="alert" hidden></p>
    <details class="github-token-alternative"><summary>Use a personal access token instead</summary>
    <form id="github-connect-form"><label for="github-token">Personal access token</label><input id="github-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required maxlength="512" placeholder="Paste your GitHub token" aria-describedby="github-token-storage">
    <p class="github-access-help"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Create a fine-grained token on GitHub ↗</a><br>Public repository read access is enough. No additional permissions are needed.</p>
    <p id="github-token-storage" class="github-access-help">Saved in this tab’s session and sent only to GitHub’s API. Disconnect to remove it.</p>
    <div class="github-access-actions"><button type="submit" class="primary-button" id="github-connect">Connect with token</button></div></form></details>`;
  document.body.append(dialog);
  for(const id of ['load-error','compare-error']){const parent=document.getElementById(id);if(parent){const action=document.createElement('button');action.type='button';action.dataset.githubAccess='';action.textContent='GitHub access';parent.append(action);}}
  const token=dialog.querySelector('#github-token'),submit=dialog.querySelector('#github-connect'),disconnect=dialog.querySelector('#github-disconnect'),error=dialog.querySelector('#github-access-error'),status=dialog.querySelector('#github-connection-status'),signIn=dialog.querySelector('#github-sign-in'),help=dialog.querySelector('#github-sign-in-help');
  let pending=null;
  function update(state){
    button.textContent=state.connected?(state.invalid?'Reconnect GitHub':'GitHub · '+state.login):'Connect GitHub';
    button.title=state.connected?'Manage GitHub access for '+state.login:'Connect a GitHub account';
    disconnect.hidden=!state.connected;submit.textContent=state.connected?'Replace with token':'Connect with token';
    signIn.disabled=!state.oauth.configured;
    signIn.hidden=state.connected&&state.mode==='oauth'&&!state.invalid;
    help.hidden=signIn.hidden;
    help.textContent=state.oauth.configured?'Approve on GitHub and return to this page. Your GitHub credentials stay on the server, and Repometer reads public repositories only.':'GitHub sign-in is awaiting one-time setup. You can connect with a personal access token below.';
    status.textContent=state.invalid?'Your GitHub connection expired or was revoked. Sign in again to reconnect.':state.connected?'Connected as '+state.login+(state.mode==='oauth'?' with GitHub sign-in.':' with a personal access token.'):'Currently using GitHub without authentication.';
    if(state.connected&&state.mode==='oauth'&&!state.invalid&&state.expiresAt)status.textContent+=' Sign in again after '+new Date(state.expiresAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'.';
    if(state.rate&&!state.invalid){status.textContent+=' '+state.rate.remaining.toLocaleString()+' / '+state.rate.limit.toLocaleString()+' API requests remaining';if(state.rate.resetAt)status.textContent+=' · resets at '+new Date(state.rate.resetAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});status.textContent+='.';}
    if(state.connected&&!state.persisted)status.textContent+=' Tab storage is unavailable, so this connection lasts only until you leave or reload this page.';
  }
  githubAccess.subscribe((state,reason)=>{update(state);if(['connected','disconnected'].includes(reason))window.dispatchEvent(new CustomEvent('github-auth-change',{detail:{reason}}));});
  update(githubAccess.state());
  document.addEventListener('click',event=>{if(event.target.closest('[data-github-access]')){error.hidden=true;token.value='';update(githubAccess.state());if(!dialog.open)dialog.showModal();(signIn.hidden?disconnect:signIn).focus();}});
  dialog.querySelector('.github-access-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{pending?.abort();token.value='';});
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();if(pending)return;const controller=new AbortController();pending=controller;const timeout=setTimeout(()=>controller.abort(),20_000);
    submit.disabled=true;disconnect.disabled=true;error.hidden=true;submit.textContent='Connecting…';
    try{await githubAccess.connect(token.value,{signal:controller.signal});token.value='';dialog.close();}
    catch(problem){if(dialog.open){error.textContent=problem.name==='AbortError'?'GitHub took too long to respond. Try connecting again.':problem instanceof TypeError?'Could not connect to GitHub. Check your connection and try again.':problem.message;error.hidden=false;}}
    finally{clearTimeout(timeout);pending=null;submit.disabled=false;disconnect.disabled=false;update(githubAccess.state());}
  });
  disconnect.addEventListener('click',async()=>{disconnect.disabled=true;error.hidden=true;try{await githubAccess.disconnect();token.value='';dialog.close();}catch(problem){error.textContent=problem.message;error.hidden=false;}finally{disconnect.disabled=false;}});
  signIn.addEventListener('click',async()=>{signIn.disabled=true;error.hidden=true;try{location.assign(await githubAccess.beginSignIn(location.href));}catch(problem){error.textContent=problem.message;error.hidden=false;signIn.disabled=false;}});
  if(githubAccess.state().authError){error.textContent=githubAccess.state().authError;error.hidden=false;dialog.showModal();}
  window.addEventListener('pagehide',()=>{pending?.abort();token.value='';});
}
