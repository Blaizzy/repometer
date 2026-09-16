import {githubAccess} from './github-access.mjs?v=9';

const API_URL='https://api.github.com/repos/Blaizzy/repometer';
const CACHE_KEY='repometer.repository-stars.v1';
const REFRESH_MS=5*60*1000;

export function mountRepositoryLink(){
  const link=document.querySelector('.repository-link');
  if(!link)return;
  const count=link.querySelector('[data-repository-stars]');
  let cached=null,pending=false,retryAfter=0;
  try{cached=JSON.parse(localStorage.getItem(CACHE_KEY));}catch{}
  if(!Number.isSafeInteger(cached?.stars)||cached.stars<0||!Number.isFinite(cached?.checkedAt))cached=null;

  function render(stars){
    const formatted=new Intl.NumberFormat('en-US').format(stars);
    count.textContent=formatted;
    link.setAttribute('aria-label',`View Blaizzy/repometer on GitHub · ${formatted} ${stars===1?'star':'stars'} (opens in a new tab)`);
    link.title=`Blaizzy/repometer · ${formatted} ${stars===1?'star':'stars'}`;
  }
  async function refresh(){
    if(pending||document.visibilityState==='hidden'||Date.now()<retryAfter||githubAccess.retryAt(API_URL))return;
    if(cached&&Date.now()-cached.checkedAt<REFRESH_MS)return;
    pending=true;
    const identity=githubAccess.state().login;
    try{
      const response=await githubAccess.transport(API_URL,{
        headers:{Accept:'application/vnd.github+json',...githubAccess.headers(API_URL)},
        credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)
      });
      if(identity===githubAccess.state().login)githubAccess.observe(API_URL,response);
      if(!response.ok)throw new Error('Star count unavailable');
      const repository=await response.json();
      if(!Number.isSafeInteger(repository.stargazers_count)||repository.stargazers_count<0)throw new Error('Invalid star count');
      cached={stars:repository.stargazers_count,checkedAt:Date.now()};
      render(cached.stars);
      try{localStorage.setItem(CACHE_KEY,JSON.stringify(cached));}catch{}
    }catch{
      // Keep the repository link usable, and retain the last known count.
      retryAfter=Date.now()+REFRESH_MS;
    }finally{pending=false;}
  }
  if(cached)render(cached.stars);
  void refresh();
  const timer=setInterval(refresh,REFRESH_MS);
  window.addEventListener('focus',refresh);
  document.addEventListener('visibilitychange',refresh);
  window.addEventListener('github-auth-change',()=>{retryAfter=0;void refresh();});
  window.addEventListener('pagehide',event=>{if(!event.persisted)clearInterval(timer);});
}
