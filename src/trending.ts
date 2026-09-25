import { prisma } from "./prisma.js";

export type TrendingVideo = {
  provider:"youtube";
  videoId:string;
  title:string;
  channelTitle:string;
  thumbnailUrl:string;
  durationSeconds:number;
  publishedAt:string;
  categoryId:string;
};

type TrendingConfig = {
  enabled:boolean;
  regionCode:string;
  categoryId:string;
  cacheTtlMs:number;
  poolSize:number;
  recentHistorySize:number;
  minDurationSeconds:number;
  maxDurationSeconds:number;
};

type CacheState = { expiresAt:number; value:TrendingVideo[] };
const cacheKey="trending_video_cache";
const cacheState = new Map<string,CacheState>();
const refreshState = new Map<string,Promise<TrendingVideo[]>>();
const recentState = new Map<string,string[]>();

function numberSetting(value:string|undefined,fallback:number){
  const n=Number(value);
  return Number.isFinite(n)&&n>=0?n:fallback;
}
async function readSetting(key:string){
  const row=await prisma.setting.findUnique({where:{key}});
  return row?.value;
}
async function config():Promise<TrendingConfig>{
  const values=await Promise.all([
    readSetting("trending_videos_enabled"),
    readSetting("trending_region_code"),
    readSetting("trending_category_id"),
    readSetting("trending_cache_ttl_minutes"),
    readSetting("trending_pool_size"),
    readSetting("trending_recent_history_size"),
    readSetting("trending_min_duration_seconds"),
    readSetting("trending_max_duration_seconds")
  ]);
  const env=process.env;
  return {
    enabled:(values[0]??env.TRENDING_VIDEOS_ENABLED??"true").toLowerCase()!=="false",
    regionCode:(values[1]??env.TRENDING_REGION_CODE??"MM").trim().toUpperCase(),
    categoryId:(values[2]??env.TRENDING_CATEGORY_ID??"24").trim(),
    cacheTtlMs:numberSetting(values[3]??env.TRENDING_CACHE_TTL_MINUTES,15)*60_000,
    poolSize:Math.max(5,Math.min(50,Math.floor(numberSetting(values[4]??env.TRENDING_POOL_SIZE,50)))),
    recentHistorySize:Math.max(1,Math.min(50,Math.floor(numberSetting(values[5]??env.TRENDING_RECENT_HISTORY_SIZE,10)))),
    minDurationSeconds:Math.floor(numberSetting(values[6]??env.TRENDING_MIN_DURATION_SECONDS,30)),
    maxDurationSeconds:Math.floor(numberSetting(values[7]??env.TRENDING_MAX_DURATION_SECONDS,0))
  };
}
function parseDuration(value:string){
  const m=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value||"");
  if(!m)return 0;
  return Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0);
}
async function fetchTrending(cfg:TrendingConfig){
  const key=process.env.YOUTUBE_API_KEY||process.env.YOUTUBE_DATA_API_KEY||"";
  if(!key)throw new Error("Trending video service is not configured.");
  const url=new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part","snippet,contentDetails,status");
  url.searchParams.set("chart","mostPopular");
  url.searchParams.set("regionCode",cfg.regionCode);
  url.searchParams.set("videoCategoryId",cfg.categoryId);
  url.searchParams.set("maxResults",String(cfg.poolSize));
  url.searchParams.set("key",key);
  const response=await fetch(url,{signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error("Trending video service is temporarily unavailable.");
  const payload:any=await response.json();
  const videos:Array<TrendingVideo>=[];
  for(const item of Array.isArray(payload.items)?payload.items:[]){
    const duration=parseDuration(String(item.contentDetails?.duration||""));
    const privacy=String(item.status?.privacyStatus||"");
    const embeddable=item.status?.embeddable===true;
    if(!item.id||privacy!=="public"||!embeddable||duration<=0)continue;
    if(duration<cfg.minDurationSeconds)continue;
    if(cfg.maxDurationSeconds>0&&duration>cfg.maxDurationSeconds)continue;
    const snippet=item.snippet||{};
    videos.push({
      provider:"youtube",
      videoId:String(item.id),
      title:String(snippet.title||""),
      channelTitle:String(snippet.channelTitle||""),
      thumbnailUrl:String(snippet.thumbnails?.high?.url||snippet.thumbnails?.medium?.url||snippet.thumbnails?.default?.url||""),
      durationSeconds:duration,
      publishedAt:String(snippet.publishedAt||""),
      categoryId:String(snippet.categoryId||cfg.categoryId)
    });
  }
  if(!videos.length)throw new Error("No usable trending videos are available right now.");
  return videos;
}
async function getPool(cfg:TrendingConfig,forceRefresh=false){
  const cached=cacheState.get(cacheKey);
  if(!forceRefresh&&cached&&cached.expiresAt>Date.now()&&cached.value.length)return cached.value;
  const running=refreshState.get(cacheKey);
  if(running)return running;
  const promise=fetchTrending(cfg).then(value=>{
    cacheState.set(cacheKey,{expiresAt:Date.now()+cfg.cacheTtlMs,value});
    return value;
  }).finally(()=>refreshState.delete(cacheKey));
  refreshState.set(cacheKey,promise);
  return promise;
}
function choose(pool:TrendingVideo[],clientId:string,cfg:TrendingConfig){
  const recent=recentState.get(clientId)||[];
  const available=pool.filter(v=>!recent.includes(v.videoId));
  const candidates=available.length?available:pool;
  const picked=candidates[Math.floor(Math.random()*candidates.length)];
  const next=[picked.videoId,...recent.filter(id=>id!==picked.videoId)].slice(0,cfg.recentHistorySize);
  recentState.set(clientId,next);
  return picked;
}
export async function getTrendingVideoForClient(clientId:string){
  const cfg=await config();
  if(!cfg.enabled)throw new Error("Trending video tasks are temporarily unavailable.");
  try{
    const pool=await getPool(cfg);
    return choose(pool,clientId,cfg);
  }catch(error){
    const cached=cacheState.get(cacheKey);
    if(cached?.value.length){
      return choose(cached.value,clientId,cfg);
    }
    throw error;
  }
}
export async function warmTrendingVideoCache(){ const cfg=await config(); if(!cfg.enabled)return {enabled:false,count:0,expiresAt:null}; const value=await getPool(cfg,false); const cached=cacheState.get(cacheKey); return {enabled:true,count:value.length,expiresAt:cached?.expiresAt??null}; }
export async function refreshTrendingVideoCache(){
  const cfg=await config();
  if(!cfg.enabled)return {enabled:false,count:0,expiresAt:null};
  const value=await getPool(cfg,true);
  const cached=cacheState.get(cacheKey);
  return {enabled:true,count:value.length,expiresAt:cached?.expiresAt??null};
}
export async function trendingConfig(){
  const cfg=await config();
  return {
    enabled:cfg.enabled,
    provider:"YouTube",
    regionCode:cfg.regionCode,
    categoryId:cfg.categoryId,
    cacheTtlMinutes:cfg.cacheTtlMs/60_000,
    poolSize:cfg.poolSize,
    recentHistorySize:cfg.recentHistorySize,
    minimumDurationSeconds:cfg.minDurationSeconds,
    maximumDurationSeconds:cfg.maxDurationSeconds
  };
}
