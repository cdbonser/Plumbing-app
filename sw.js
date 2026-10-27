// Central Plumbing service worker: ONLY shows push notifications and opens the app when one is tapped.
// No fetch handler and no caching, so it can never affect how the app loads.
const APP=new URL('./',self.location).href; // https://centralplumbingne.github.io/Plumbing-app/
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(_){d={body:e.data?e.data.text():''}}
  e.waitUntil(self.registration.showNotification(d.title||'Central Plumbing',{body:d.body||'',icon:'icon-192.png',badge:'icon-192.png',tag:d.tag||undefined,data:{job:d.jobId||''}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const job=(e.notification.data||{}).job||'';const url=APP+(job?'?job='+encodeURIComponent(job):'');
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    for(const c of cs){if(c.url.startsWith(APP)&&'focus' in c){if(job)c.postMessage({job});return c.focus()}}
    return self.clients.openWindow(url)}))});
