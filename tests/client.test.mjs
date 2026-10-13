import test from 'node:test';
import assert from 'node:assert/strict';
import { SocialQueryClient } from '../src/client.mjs';

const endpoint = {id:'get_test_search',method:'GET',path:'/v1/test/search',creditCost:2,params:[{name:'query',required:true},{name:'limit'}]};
const fixture = (item=endpoint) => {
  const calls=[];
  const client=new SocialQueryClient({apiKey:'test-only-key',fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return Response.json({success:true,credits_used:0,data:url.pathname==='/v1/meta/endpoints'?{endpoints:[item]}:{items:[]}});
  }});
  return {client,calls};
};

test('catalog discovery omits credentials; a data call encodes query and sends one credential header',async()=>{
  const {client,calls}=fixture();
  await client.callEndpoint({endpointId:endpoint.id,parameters:{query:'a & b',limit:10},maxCredits:2,idempotencyKey:'operation-123'});
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.headers['x-api-key'],undefined);
  assert.equal(calls[1].url.origin,'https://socialquery.dev');
  assert.equal(calls[1].url.searchParams.get('query'),'a & b');
  assert.equal(calls[1].options.headers['x-api-key'],'test-only-key');
  assert.equal(calls[1].options.headers['X-Max-Credits'],'2');
  assert.equal(calls[1].options.headers['Idempotency-Key'],'operation-123');
  assert.equal(calls[1].options.redirect,'error');
  assert.ok(!calls[1].url.href.includes('test-only-key'));
});

test('budget, required inputs, unknown inputs, and methods prevent data requests',async()=>{
  for(const input of [
    {parameters:{query:'x'},maxCredits:1},
    {parameters:{query:'x'},maxCredits:NaN},
    {parameters:{},maxCredits:2},
    {parameters:{query:'x',unknown:'x'},maxCredits:2},
    {parameters:[],maxCredits:2},
  ]){
    const {client,calls}=fixture();
    await assert.rejects(client.callEndpoint({endpointId:endpoint.id,...input}));
    assert.equal(calls.length,1);
  }
  const {client,calls}=fixture({...endpoint,method:'POST'});
  await assert.rejects(client.callEndpoint({endpointId:endpoint.id,parameters:{query:'x'},maxCredits:2}),/GET/);
  assert.equal(calls.length,1);
});

test('alternative parameters are enforced and path parameters are substituted safely',async()=>{
  const item={...endpoint,path:'/v1/test/{id}',params:[{name:'id',required:true},{name:'url'},{name:'handle'}],oneOfParameters:[['url','handle']]};
  const {client,calls}=fixture(item);
  await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{id:'abc'},maxCredits:2}),/alternative/);
  for(const id of ['..','a/b','%2e%2e'])await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{id,handle:'test'},maxCredits:2}),/Path/);
  await client.callEndpoint({endpointId:item.id,parameters:{id:'abc-123',handle:'test'},maxCredits:2});
  assert.equal(calls.at(-1).url.pathname,'/v1/test/abc-123');
  assert.equal(calls.at(-1).url.searchParams.has('id'),false);
});

test('arbitrary origins and traversal paths fail before fetch',async()=>{
  let calls=0;
  const client=new SocialQueryClient({apiKey:'test',fetchImpl:async()=>{calls++;throw Error('must not fetch');}});
  for(const path of ['https://evil.example','//evil.example','/v1/../admin','/v1/%2e%2e/admin','/api/admin','/v1/test?token=x','/v1/test\\evil'])await assert.rejects(client.get(path),/Unsupported/);
  assert.equal(calls,0);
});

test('errors do not echo private response text or retry',async()=>{
  let calls=0;
  const client=new SocialQueryClient({apiKey:'test-only-key',fetchImpl:async()=>{calls++;return new Response('private secret text',{status:401,headers:{'x-request-id':'req_123'}});}});
  await assert.rejects(client.get('/v1/github/profile'),error=>error.message.includes('HTTP 401')&&error.message.includes('req_123')&&!error.message.includes('secret'));
  assert.equal(calls,1);
});

test('missing keys fail locally; oversized responses are rejected',async()=>{
  const client=new SocialQueryClient({apiKey:'',fetchImpl:()=>{throw Error('unexpected fetch');}});
  await assert.rejects(client.get('/v1/github/profile'),/SOCIALQUERY_API_KEY/);
  const large=new SocialQueryClient({apiKey:'test',fetchImpl:async()=>new Response(' '.repeat(4*1024*1024+1))});
  await assert.rejects(large.get('/v1/github/profile'),/exceeds/);
});

test('mutations require explicit intent and replay identity, preserving method, path and typed JSON',async()=>{
  for (const method of ['POST','PATCH','DELETE']) {
    const item={id:'change_job',method,path:'/v1/web/jobs/{job_id}',creditCost:0,params:[{name:'job_id',required:true},{name:'urls'},{name:'options'}]};
    const {client,calls}=fixture(item);
    const input={endpointId:item.id,parameters:{job_id:'job_123',urls:['https://example.com'],options:{fresh:true,limit:2}},maxCredits:0};
    await assert.rejects(client.callEndpoint(input),/GET only/);
    await assert.rejects(client.callEndpoint({...input,allowMutation:true}),/idempotencyKey/);
    assert.ok(calls.every(c=>c.url.pathname==='/v1/meta/endpoints'));
    await client.callEndpoint({...input,allowMutation:true,idempotencyKey:'job-action-123'});
    const sent=calls.at(-1);
    assert.equal(sent.url.pathname,'/v1/web/jobs/job_123');assert.equal(sent.url.search,'');
    assert.equal(sent.options.method,method);
    assert.deepEqual(JSON.parse(sent.options.body),{urls:['https://example.com'],options:{fresh:true,limit:2}});
    assert.equal(sent.options.headers['Content-Type'],'application/json');
  }
});

test('nested invalid numbers cannot silently become JSON null',async()=>{
  const {client,calls}=fixture({...endpoint,params:[{name:'query',required:true},{name:'options'}]});
  await assert.rejects(client.callEndpoint({endpointId:endpoint.id,parameters:{query:'x',options:{limit:Infinity}},maxCredits:2}),/finite JSON/);
  assert.equal(calls.length,1);
});

test('metered quotes reserve depth, transmit server cap, and reject underfunding before data requests',async()=>{
 const item={...endpoint,creditPricing:{type:'per_item',creditsPerItem:2,limitParameter:'limit',defaultLimit:25,maxLimit:100}};
 const {client,calls}=fixture(item);
 await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{query:'x',limit:10},maxCredits:19}),/maximum request charge/);
 assert.equal(calls.length,1);
 await client.callEndpoint({endpointId:item.id,parameters:{query:'x',limit:'10'},maxCredits:20});
 assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'20');
 await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{query:'x'},maxCredits:49}),/maximum request charge/);
 for(const limit of [null,true,0,101,'2.5'])await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{query:'x',limit},maxCredits:200}));
});
test('client treats missing, invalid and over-budget usage as failures without retrying',async()=>{
 for(const credits_used of [undefined,-1,3,1.5]) {
 let calls=0;const client=new SocialQueryClient({apiKey:'test',fetchImpl:async()=>{calls++;return Response.json({success:true,credits_used,data:{}});}});
 await assert.rejects(client.request('GET','/v1/test',{}, {maxCredits:2}),/credit usage/);assert.equal(calls,1);
 }
});

test('resolved prices preserve caller caps for exact enforcement before server reservation',async()=>{
 const item={...endpoint,path:'/v1/prism/lookup',creditCost:1,creditPricing:{type:'resolved_endpoint',maxCredits:5},params:[{name:'url',required:true}]};
 const {client,calls}=fixture(item);
 await client.callEndpoint({endpointId:item.id,parameters:{url:'https://github.com/octocat/Hello-World'},maxCredits:1});
 assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'1');
 for(const maxCredits of [undefined,-1,1.5])await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{url:'https://github.com/octocat/Hello-World'},maxCredits}));
 const bad=fixture({...item,path:'/v1/test/search'});await assert.rejects(bad.client.callEndpoint({endpointId:item.id,parameters:{url:'https://example.com'},maxCredits:5}),/Invalid resolved pricing/);assert.equal(bad.calls.length,1);
});

test('batch transcript budgets count IDs before a mutation request',async()=>{
 const item={...endpoint,id:'post_youtube_transcripts',method:'POST',path:'/v1/youtube/transcripts',creditCost:3,params:[{name:'ids',required:true}],creditPricing:{type:'per_successful_input',arrayParameter:'ids',creditsPerItem:3,maxItems:100}};
 const {client,calls}=fixture(item),params={ids:['bjVIDXPP7Uk','00000000000']};
 await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:params,maxCredits:5,allowMutation:true,idempotencyKey:'batch-underfunded'}),/maximum request charge/);
 assert.equal(calls.length,1);
 await client.callEndpoint({endpointId:item.id,parameters:params,maxCredits:6,allowMutation:true,idempotencyKey:'batch-ok'});
 assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'6');assert.deepEqual(JSON.parse(calls.at(-1).options.body),params);
});

test('profile batch quotes platform tiers and preserves nested items and caller IDs',async()=>{
 const item={...endpoint,id:'post_prism_profiles',method:'POST',path:'/v1/prism/profiles',creditCost:1,params:[{name:'items',required:true}],creditPricing:{type:'profile_batch',maxItems:50,defaultCredits:1,platformCredits:{linkedin:5}}};
 const {client,calls}=fixture(item),params={items:[{platform:'bluesky',handle:'bsky.app',custom_id:'first'},{platform:'linkedin',handle:'example'}]};
 await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:params,maxCredits:5,allowMutation:true,idempotencyKey:'underfunded'}),/maximum request charge/);assert.equal(calls.length,1);
 await client.callEndpoint({endpointId:item.id,parameters:params,maxCredits:6,allowMutation:true,idempotencyKey:'profile-batch'});assert.deepEqual(JSON.parse(calls.at(-1).options.body),params);assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'6');
});


test('post-stat batches quote URL platform tiers without following input links',async()=>{
 const item={...endpoint,id:'post_prism_post_stats',method:'POST',path:'/v1/prism/post-stats',creditCost:1,params:[{name:'urls',required:true}],creditPricing:{type:'post_stats_batch',maxItems:100,defaultCredits:1,platformCredits:{instagram:2,linkedin:5}}};
 const {client,calls}=fixture(item),params={urls:['https://instagram.com/example/p/abc/','https://www.linkedin.com/posts/example','https://youtu.be/jNQXAC9IVRw','invalid']};
 await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:params,maxCredits:8,allowMutation:true,idempotencyKey:'underfunded'}),/maximum request charge/);assert.equal(calls.length,1);
 await client.callEndpoint({endpointId:item.id,parameters:params,maxCredits:9,allowMutation:true,idempotencyKey:'post-stats-batch'});assert.deepEqual(JSON.parse(calls.at(-1).options.body),params);assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'9');
});

test('trend-board maximum holds depend on industry fanout and reject insufficient budgets before data access',async()=>{
 const item={id:'get_tiktok_hashtags_popular',method:'GET',path:'/v1/tiktok/hashtags/popular',creditCost:6,params:[{name:'industry'}],creditPricing:{type:'trend_boards',creditsPerItem:2,minimumCredits:6,maxItems:48}};
 const{client,calls}=fixture(item);await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{industry:'all'},maxCredits:95}),/maximum/);assert.equal(calls.length,1);
 await client.callEndpoint({endpointId:item.id,parameters:{industry:'all'},maxCredits:96});assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'96');
 await client.callEndpoint({endpointId:item.id,parameters:{},maxCredits:6});assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'6');
 const bad=fixture({...item,path:'/v1/test/search'});await assert.rejects(bad.client.callEndpoint({endpointId:item.id,parameters:{},maxCredits:96}),/Invalid trend-board/);assert.equal(bad.calls.length,1);
});

test('video boards include fixed overhead in the maximum quote and refuse invalid limits',async()=>{
 const item={id:'get_tiktok_videos_popular',method:'GET',path:'/v1/tiktok/videos/popular',creditCost:26,params:[{name:'limit'}],creditPricing:{type:'board_plus_item',baseCredits:25,creditsPerItem:1,defaultLimit:20,maxLimit:20}};
 const{client,calls}=fixture(item);await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{},maxCredits:44}),/maximum/);assert.equal(calls.length,1);
 await client.callEndpoint({endpointId:item.id,parameters:{},maxCredits:45});assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'45');
 await client.callEndpoint({endpointId:item.id,parameters:{limit:4},maxCredits:29});assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'29');
 for(const limit of [0,21,1.5,'2e1',true])await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{limit},maxCredits:45}),/limit/);
});

 test('comment lookup quotes the explicit deep-scan price and fails closed on malformed metadata',async()=>{
 const item={id:'get_tiktok_comment',method:'GET',path:'/v1/tiktok/comment',creditCost:2,params:[{name:'deep_scan'}],creditPricing:{type:'boolean_option',parameter:'deep_scan',defaultCredits:2,enabledCredits:6}};
 const{client,calls}=fixture(item);await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{deep_scan:true},maxCredits:5}),/maximum/);assert.equal(calls.length,1);
 for(const value of [true,'true']){await client.callEndpoint({endpointId:item.id,parameters:{deep_scan:value},maxCredits:6});assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'6');}
 for(const value of [false,'false',undefined])await client.callEndpoint({endpointId:item.id,parameters:value===undefined?{}:{deep_scan:value},maxCredits:2});
 for(const value of [0,1,null,'yes'])await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{deep_scan:value},maxCredits:6}),/deep_scan/);
 const bad=fixture({...item,creditPricing:{...item.creditPricing,enabledCredits:2}});await assert.rejects(bad.client.callEndpoint({endpointId:item.id,parameters:{deep_scan:true},maxCredits:6}),/pricing metadata/);assert.equal(bad.calls.length,1);
 });

test('shop market budgets deduplicate markets and reject insufficient caps or malformed catalog data before access',async()=>{
 const item={id:'get_tiktokshop_sales',method:'GET',path:'/v1/tiktokshop/sales',creditCost:0,params:[{name:'regions'}],creditPricing:{type:'shop_regions',creditsPerRegion:1,maxRegions:8,defaultRegion:'US'}};
 const{client,calls}=fixture(item);await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{regions:'US,GB'},maxCredits:1}),/maximum/);assert.equal(calls.length,1);
 await client.callEndpoint({endpointId:item.id,parameters:{regions:'US,gb,US'},maxCredits:2});assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'2');
 await client.callEndpoint({endpointId:item.id,parameters:{},maxCredits:1});
 for(const regions of [0,'','US,','ZZ',Array(9).fill('US').join(',')])await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{regions},maxCredits:8}),/markets/);
 const bad=fixture({...item,creditPricing:{...item.creditPricing,creditsPerRegion:0}});await assert.rejects(bad.client.callEndpoint({endpointId:item.id,parameters:{},maxCredits:8}),/pricing metadata/);assert.equal(bad.calls.length,1);
});

test('news quote accounts for engines, depth, country deduplication and leg caps',async()=>{
 const item={id:'get_search_news',method:'GET',path:'/v1/search/news',creditCost:2,params:['query','engines','countries','depth','max_legs'].map(name=>({name})),creditPricing:{type:'news_legs',baseCredits:2,googleCreditsPerLeg:1,bingArticlesPerCredit:5,maxLegs:12}};
 const{client,calls}=fixture(item),parameters={query:'AI',engines:'google,bing',countries:'US,GB,us',depth:100,max_legs:1};
 await assert.rejects(client.callEndpoint({endpointId:item.id,parameters,maxCredits:6}),/maximum/);assert.equal(calls.length,1);
 await client.callEndpoint({endpointId:item.id,parameters,maxCredits:7});assert.equal(calls.at(-1).options.headers['X-Max-Credits'],'7');
 for(const patch of [{depth:11},{depth:true},{engines:'web'},{max_legs:0},{countries:''}])await assert.rejects(client.callEndpoint({endpointId:item.id,parameters:{...parameters,...patch},maxCredits:62}),/news/);
 const bad=fixture({...item,creditPricing:{...item.creditPricing,baseCredits:0}});await assert.rejects(bad.client.callEndpoint({endpointId:item.id,parameters,maxCredits:7}),/pricing metadata/);
});
