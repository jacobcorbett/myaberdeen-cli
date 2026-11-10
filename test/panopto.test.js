import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveDatabase } from '../src/database.js';
import { panoptoLinks, normaliseCaptions, transcriptText, viewerUrl, storeRecording, getRecordings, searchRecordings, exportRecordings } from '../src/panopto-data.js';
const id = '11111111-1111-1111-1111-111111111111';
const folder = '22222222-2222-2222-2222-222222222222';
function archive(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'myab-panopto-test-'));
 const db=new ArchiveDatabase(path.join(dir,'test.sqlite'));
 t.after(()=>{try{db.close();}catch(e){if(e.code!=='ERR_INVALID_STATE')throw e;}fs.rmSync(dir,{recursive:true,force:true});});return {db,dir};
}
const record = () => ({id,title:'Sample lecture',url:viewerUrl(id),duration:90,folderId:folder,chapters:[{start:0,title:'Introduction'}],aiSummary:'An example',transcripts:{English:{captions:[{start:1.25,duration:2.5,text:'Access control'}, {start:4,duration:2,text:'Second topic'}],automatic:true}},playback:{position:0}});
test('discover only approved-host viewer and folder links, including HTML entities',()=>{
 const found=panoptoLinks({body:`<a href="${viewerUrl(id)}&amp;start=3">View</a> https://abdn.cloud.panopto.eu/Panopto/Pages/Sessions/List.aspx#folderID=${folder}`,bad:`https://abdn.cloud.panopto.eu.evil.test/Panopto/Pages/Viewer.aspx?id=${folder}`});
 assert.deepEqual(found,{recordings:[id],folders:[folder]});
 assert.throws(()=>viewerUrl('../file'));
});
test('caption parsing rejects malformed data and preserves sorted fractional timings',()=>{
 const captions=normaliseCaptions([{Time:4,CaptionDuration:2,Caption:'Later'},{Time:1.25,CaptionDuration:2.5,Caption:'First'}]);
 assert.equal(captions[0].text,'First');
 assert.match(transcriptText(captions,'srt'),/00:00:01,250 --> 00:00:03,750/);
 assert.match(transcriptText(captions,'vtt'),/^WEBVTT\n/);
 assert.throws(()=>normaliseCaptions({error:'denied'}));
 assert.throws(()=>normaliseCaptions([{Time:-2,CaptionDuration:1,Caption:'bad'}]));
 assert.throws(()=>normaliseCaptions([{Time:2,CaptionDuration:NaN,Caption:'bad'}]));
});
test('archive scopes reads and changes; viewing progress does not change lecture content',t=>{
 const {db}=archive(t);const run=db.startRun();storeRecording(db,'course-a',record());
 storeRecording(db,'course-b',{...record(),title:'Other course'});
 let count=db.changes({courseIds:['course-a'],since:0,limit:100}).length;
 storeRecording(db,'course-a',{...record(),playback:{position:20}});
 assert.equal(db.changes({courseIds:['course-a'],since:0,limit:100}).length,count);
 assert.equal(getRecordings(db,['course-a']).length,1);
 assert.equal(getRecordings(db,['course-a'])[0].playback.position,20);
 const hits=searchRecordings(getRecordings(db,['course-a']),'access');
 assert.equal(hits.length,1);assert.equal(hits[0].matches[0].start,1.25);assert.match(hits[0].matches[0].url,/start=1.25/);
 db.finishRun(run,'completed',1);
});
test('partial folder refresh preserves presence; only complete scoped enumeration marks absence',t=>{
 const {db}=archive(t);const first=db.startRun();storeRecording(db,'a',record());storeRecording(db,'b',record());db.finishRun(first,'completed',2);
 const second=db.startRun();db.finishSection(second,'a','panopto','partial');
 assert.equal(getRecordings(db,['a'])[0].presence,'current');
 db.finishSection(second,'a','panopto','completed');
 assert.equal(getRecordings(db,['a'])[0].presence,'historical');assert.equal(getRecordings(db,['b'])[0].presence,'current');
});
test('exports readable transcripts without rewriting unchanged files',t=>{
 const {db,dir}=archive(t);db.startRun();storeRecording(db,'a',record());exportRecordings(db,'a',dir);
 const filename=path.join(dir,'recordings',id,'English.srt');const before=fs.statSync(filename).mtimeMs;
 assert.match(fs.readFileSync(filename,'utf8'),/Access control/);exportRecordings(db,'a',dir);assert.equal(fs.statSync(filename).mtimeMs,before);
 assert.match(fs.readFileSync(path.join(dir,'recordings',id,'README.md'),'utf8'),/start=1.25/);
});
test('v2 upgrade makes a private backup and retains existing archive',t=>{
 const {db,dir}=archive(t);db.db.exec('PRAGMA user_version=2');db.close();
 const reopened=new ArchiveDatabase(path.join(dir,'test.sqlite'));
 try {
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,5);assert.ok(fs.existsSync(reopened.backupPath));
  if(process.platform!=='win32')assert.equal(fs.statSync(reopened.backupPath).mode&0o777,0o600);
 } finally { reopened.close(); }
});

import { PanoptoClient } from '../src/panopto-browser.js';
import { matchesCourseFolder, syncPanopto } from '../src/panopto-sync.js';
import { parseArgs } from '../src/cli-options.js';
import { allowedMediaUrl, downloadRecording } from '../src/panopto-download.js';
test('recording commands reject unbounded scope and invalid options',()=>{
 for(const command of ['panopto-sync','recordings','recording','transcript','panopto-download']) assert.throws(()=>parseArgs([command]));
 assert.throws(()=>parseArgs(['transcript','--active','--id',id,'--format','html']));
 assert.throws(()=>parseArgs(['check','--active','--limit-recordings','1']));
 assert.equal(parseArgs(['check','--active','--panopto','--limit-recordings','1']).options.limitRecordings,1);
});
test('course discovery requires the correct code and academic year, including highlighted search results',()=>{
 assert.equal(matchesCourseFolder('<span class="match">CS4028</span>-2026-27','CS4028_27'),true);
 assert.equal(matchesCourseFolder('CS4028-2025-26','CS4028_27'),false);
 assert.equal(matchesCourseFolder('CS4048 (2026-27): Robotics','CS4028_27'),false);
 assert.equal(matchesCourseFolder('CS4028','CS4028_27'),false);
});
test('website pagination does not stop early on short pages and rejects repeated pages',async()=>{
 const client=new PanoptoClient({context:{}});let calls=0;
 client.readJson=async()=>({d:{Results:[{DeliveryID:id}],TotalNumber:2}});
 await assert.rejects(client.sessions({folder}),/repeated/);
 client.readJson=async()=>({d:{Results:calls++===0?[{DeliveryID:id}]:[{DeliveryID:folder}],TotalNumber:2}});
 assert.equal((await client.sessions({folder})).length,2);
 client.readJson=async()=>({d:{Results:[],TotalNumber:1}});
 await assert.rejects(client.sessions({folder}),/before the advertised total/);
 await assert.rejects(client.sessions(),/explicit/);
});
test('read transport rejects writes, redirects and authentication errors without leaking request URLs',async()=>{
 const client=new PanoptoClient({context:{request:{post:async()=>({status:()=>302,dispose:async()=>{}})}}});
 await assert.rejects(client.readJson('/Panopto/Services/Data.svc/DeleteSessions',{}),/Unsupported/);
 await assert.rejects(client.readJson('/Panopto/Services/Data.svc/GetSessions',{}),/sign-in/);
});
test('scoped sync retains good transcripts after failures and enforces a global attempt limit',async t=>{
 const {db}=archive(t);for(const course of ['a','b'])db.upsertCourse({id:course,courseId:`CS1000_27`,name:course,isAvailable:true});
 const first=db.startRun();storeRecording(db,'a',record());db.finishRun(first,'completed',1);
 const courses=db.db.prepare('SELECT * FROM courses').all();
 let attempts=0;const client={folderSessions:async()=>[{Id:id},{Id:folder}],recording:async()=>{attempts++;throw new Error('Temporary failure');}};
 const result=await syncPanopto({database:db,config:{panoptoFolders:{a:[folder],b:[folder]}},courses,limitRecordings:1,client});
 assert.equal(attempts,1);assert.equal(result.deferred,3);assert.equal(result.status,'partial');
 assert.equal(getRecordings(db,['a'])[0].transcripts.English.captions.length,2);
 assert.equal(getRecordings(db,['a'])[0].presence,'current');
});
test('download only follows supported HTTPS hosts and never forwards Panopto cookies to CDN',async t=>{
 const {db,dir}=archive(t);assert.throws(()=>allowedMediaUrl('http://abdn.cloud.panopto.eu/test'));
 assert.throws(()=>allowedMediaUrl('https://abdn.cloud.panopto.eu.evil.test/file'));
 const requests=[];const client={context:{cookies:async()=>[{name:'session',value:'synthetic'}]},recording:async()=>({record:{id,title:'Test',downloadable:true},downloadUrl:'https://abdn.cloud.panopto.eu/allowed.mp4'})};
 const result=await downloadRecording({client,database:db,config:{downloadDir:dir},courseId:'a',id,fetchImpl:async(url,options)=>{
   requests.push({url,headers:options.headers});
   return requests.length===1?new Response(null,{status:302,headers:{location:'https://download.cdn.cloud.panopto.eu/allowed.mp4'}}):new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'video/mp4','content-length':'3'}});
 }});
 assert.equal(requests[0].headers.Cookie,'session=synthetic');assert.equal(requests[1].headers.Cookie,undefined);
 assert.equal(result.bytes,3);assert.equal(fs.readFileSync(result.path).length,3);
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM recording_assets').get().n,1);
});
test('oversized and HTML downloads leave no file or catalogue entry',async t=>{
 const {db,dir}=archive(t);const client={context:{cookies:async()=>[]},recording:async()=>({record:{id,title:'Test',downloadable:true},downloadUrl:'https://abdn.cloud.panopto.eu/allowed.mp4'})};
 for(const type of ['video/mp4','text/html'])await assert.rejects(downloadRecording({client,database:db,config:{downloadDir:dir},courseId:'a',id,maxBytes:2,fetchImpl:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':type}})}));
 assert.deepEqual(fs.readdirSync(path.join(dir,'_panopto-media',id)),[]);assert.equal(db.db.prepare('SELECT COUNT(*) n FROM recording_assets').get().n,0);
});

test('an unsolicited partial-content response is not catalogued as a complete video',async t=>{
 const {db,dir}=archive(t);
 const client={context:{cookies:async()=>[]},recording:async()=>({record:{id,title:'Test',downloadable:true},downloadUrl:'https://abdn.cloud.panopto.eu/allowed.mp4'})};
 await assert.rejects(downloadRecording({client,database:db,config:{downloadDir:dir},courseId:'a',id,fetchImpl:async()=>new Response(new Uint8Array([1,2,3]),{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-2/100'}})}),/206/);
 assert.equal(db.db.prepare('SELECT COUNT(*) n FROM recording_assets').get().n,0);
});
