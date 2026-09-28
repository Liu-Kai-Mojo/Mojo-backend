import "dotenv/config";
import express from "express";
import cors from "cors";
import { execFile, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { Prisma, Role, IdentifierType, MessageStatus, TaskStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./prisma.js";
import { auth, hashPassword, verifyPassword, issueToken } from "./auth.js";
import { registerSchema, loginSchema, movieSchema, messageSchema, taskSchema } from "./validation.js";
import { uniqueUserId, uniqueMovieId, uniqueHistoryId, uniqueMessageId, uniqueSettingId, uniqueWalletTransactionId, uniqueTaskId, uniqueInviteCode, uniqueAuditLogId, uniqueTaskSessionId } from "./utils/codes.js";
import { getTrendingVideoForClient, getTrendingVideosForClient, getAlternativeVideoForTask, getCurrentTrailerCandidates, trendingConfig, normalizeMovieTitle } from "./trending.js";

const app=express();
app.set("trust proxy",1);
const port=Number(process.env.PORT||8787);
const isProduction=process.env.NODE_ENV==="production";
const normalize=(v:string)=>v.trim().replace(/\/+$/g,"");
const defaults=["https://box-office-mojo.pages.dev","https://mojo-client.pages.dev","https://mojo-admin.pages.dev","https://mojo-administrator.pages.dev","https://mojo-owner.pages.dev"];
const origins=Array.from(new Set([...defaults,...(process.env.FRONTEND_ORIGINS||"").split(",").map(normalize).filter(Boolean)]));
if(!isProduction) origins.push("http://localhost:5173","http://127.0.0.1:5173");
app.disable("x-powered-by");
app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");res.setHeader("Content-Security-Policy","default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");res.setHeader("Cross-Origin-Resource-Policy","same-site");if(isProduction)res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");next();});
app.use(cors({origin(origin,cb){if(!origin||origins.includes(normalize(origin)))return cb(null,true);return cb(new Error("Origin is not allowed by CORS."));},credentials:true,methods:["GET","POST","PATCH","DELETE","OPTIONS"],allowedHeaders:["Content-Type","Authorization","Idempotency-Key"]}));
app.use(express.json({limit:"2mb"}));

// Lightweight in-process rate limiting. This intentionally protects only sensitive API classes;
// normal authenticated reads remain unrestricted. For multi-replica deployments, an upstream
// gateway/rate-limit service should be used as the shared enforcement layer.
type RateBucket={count:number;resetAt:number};
const rateBuckets=new Map<string,RateBucket>();
const rateLimit=(name:string,limit:number,windowMs:number)=>(req:express.Request,res:express.Response,next:express.NextFunction)=>{
  const key=name+":"+String(req.ip||req.socket.remoteAddress||"unknown");
  const now=Date.now();
  const current=rateBuckets.get(key);
  if(!current||current.resetAt<=now){rateBuckets.set(key,{count:1,resetAt:now+windowMs});return next();}
  current.count+=1;
  if(current.count>limit){res.setHeader("Retry-After",Math.ceil((current.resetAt-now)/1000));return res.status(429).json({error:"Too many requests. Please try again later.",code:"RATE_LIMITED"});}
  return next();
};
const cleanupRateBuckets=()=>{const now=Date.now();for(const [key,bucket] of rateBuckets){if(bucket.resetAt<=now)rateBuckets.delete(key);}};
const rateCleanup=setInterval(cleanupRateBuckets,60_000);rateCleanup.unref();

app.post("/api/auth/login",rateLimit("login",10,60_000));
app.post("/api/auth/register",rateLimit("register",5,15*60_000));
app.post("/api/client/messages",rateLimit("client-message",30,60_000));
app.post("/api/admin/messages",rateLimit("admin-message",60,60_000));
app.patch("/api/admin/messages",rateLimit("admin-message-status",60,60_000));
app.patch("/api/admin/balances",rateLimit("admin-balance",60,60_000));
app.post("/api/admin/balances",rateLimit("admin-balance",60,60_000));


app.use((req,res,next)=>{if(req.path.startsWith("/api/"))res.setHeader("Cache-Control","no-store");next();});

function detectIdentifier(v:string){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)?IdentifierType.EMAIL:IdentifierType.PHONE;}
function safeUser(u:any){return {id:u.id,name:u.name,identifier:u.identifier,identifierType:u.identifierType,role:u.role,active:u.active,adminId:u.adminId??null,balanceCents:u.balanceCents??0,frozenCents:u.frozenCents??0,creditScore:u.creditScore??1000,welcomeBonusGrantedAt:u.welcomeBonusGrantedAt??null,createdAt:u.createdAt,...(u.role===Role.ADMIN?{inviteCode:u.inviteCode??null}:{})};}
async function audit(actorId:string|undefined, targetId:string|undefined, action:string, details?:unknown){
  await prisma.auditLog.create({
    data:{
      id:await uniqueAuditLogId(),
      actorId:actorId||null,
      targetId:targetId||null,
      action,
      details:details===undefined?null:JSON.stringify(details)
    }
  });
}
async function ensureOwnerFromEnv(){
  const identifierRaw=(process.env.OWNER_EMAIL||process.env.OWNER_IDENTIFIER)?.trim();
  const password=process.env.OWNER_PASSWORD?.trim();
  if(!identifierRaw||!password)return;
  const identifier=identifierRaw.includes("@")?identifierRaw.toLowerCase():identifierRaw;
  const passwordHash=await hashPassword(password);
  const existing=await prisma.user.findUnique({where:{identifier}});
  if(existing){
    if(existing.role!==Role.OWNER || !existing.active || !(await verifyPassword(password,existing.passwordHash))){
      await prisma.user.update({where:{id:existing.id},data:{name:"Studio Owner",passwordHash,role:Role.OWNER,active:true}});
    }
    return;
  }
  await prisma.user.create({data:{id:await uniqueUserId(),name:"Studio Owner",identifier,identifierType:detectIdentifier(identifier),passwordHash,role:Role.OWNER,active:true}});
}

function param(req:express.Request,k:string){const v=req.params[k];return Array.isArray(v)?v[0]||"":v||"";}
function asyncRoute(fn:(req:express.Request,res:express.Response,next:express.NextFunction)=>unknown|Promise<unknown>):express.RequestHandler{return(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);}
function money(c:number){return Math.max(0,Math.round(c));}
function defaultTaskAmount(balanceCents:number,_sequence:number){const available=Math.max(0,Math.floor(balanceCents));if(available<=0)return 0;const min=Math.max(1,Math.ceil(available*.06));const max=Math.max(min,Math.floor(available*.10));return secureRandomCents(min,max);}
function taskCommissionRate(balanceCents:number){const available=Math.max(0,Number(balanceCents||0));if(available>=2000000)return .016;if(available>=500000)return .014;if(available>=150000)return .008;return .007;}
function defaultCommission(amount:number,balanceCents:number){return Math.max(1,Math.round(Math.max(0,amount)*taskCommissionRate(balanceCents)));}

type VipRule={taskCount:number;commissionRateBps:number};
type BonusConfig={content:string;quickActions:string[];date:string};
type TaskManagementConfig={taskCount:number;requiredDepositCents:number;amountCents:number;vipLevel:string;resetCount:number;cycleStartSequence:number;combinationTaskCount:number;combinationTaskAmountCents:number;combinationTaskSequences:number[];combinationCommissionRateBps:number;combinationTaskRound:number;bonus:BonusConfig|null};
const taskConfigKey=(clientId:string)=>`client_task_config_${clientId}`;
const dailyResetUsageKey=(clientId:string)=>`client_task_reset_usage_${clientId}`;
const taskCycleKey=(clientId:string)=>`client_task_cycle_${clientId}`;
const vipRuleKey=(vip:string)=>`vip_rule_${vip}`;
const clampTaskCount=(value:number)=>Math.max(1,Math.min(100,Math.trunc(Number.isFinite(value)?value:30)));
const clampMoneyCents=(value:number)=>Math.max(0,Math.min(1_000_000_000,Math.trunc(Number.isFinite(value)?value:0)));
const clampRateBps=(value:number)=>Math.max(1,Math.min(10000,Math.trunc(Number.isFinite(value)?value:70)));
const normalizeVipLevel=(value:unknown)=>{const raw=String(value??"VIP1").trim().toUpperCase();return /^VIP[0-9]{1,2}$/.test(raw)?raw:"VIP1";};
function defaultVipRule(vip:string):VipRule{
  const n=Math.max(1,Math.min(100,Number(String(vip).replace(/\\D/g,""))||1));
  return {taskCount:n===1?30:n===2?40:n===3?50:n===4?60:60,commissionRateBps:n===1?70:n===2?80:n===3?140:n===4?160:160};
}
async function getVipRule(vipInput:unknown):Promise<VipRule>{
  const vip=normalizeVipLevel(vipInput);const fallback=defaultVipRule(vip);
  const row=await prisma.setting.findUnique({where:{key:vipRuleKey(vip)}});
  if(!row)return fallback;
  try{const parsed=JSON.parse(row.value||"{}");return {taskCount:clampTaskCount(Number(parsed.taskCount??fallback.taskCount)),commissionRateBps:clampRateBps(Number(parsed.commissionRateBps??fallback.commissionRateBps))};}catch{return fallback;}
}
async function getTaskManagementConfig(clientId:string):Promise<TaskManagementConfig>{
  const [configRow,cycleRow]=await Promise.all([prisma.setting.findUnique({where:{key:taskConfigKey(clientId)}}),prisma.setting.findUnique({where:{key:taskCycleKey(clientId)}})]);
  let parsed:any={};try{parsed=configRow?.value?JSON.parse(configRow.value):{};}catch{}
  const vipLevel=normalizeVipLevel(parsed.vipLevel??"VIP1");const vipRule=await getVipRule(vipLevel);
  const taskCount=vipRule.taskCount;
  const sequences:number[]=Array.isArray(parsed.combinationTaskSequences)
    ? Array.from(new Set<number>(
        parsed.combinationTaskSequences
          .map((v:any)=>Math.trunc(Number(v)))
          .filter((v:number)=>Number.isInteger(v)&&v>=1&&v<=taskCount)
      )).sort((a,b)=>a-b)
    : [];
  let bonus:BonusConfig|null=null;try{const raw=parsed.bonus??null;if(raw&&typeof raw==="object"){const content=String(raw.content??"").trim();const quickActions=Array.isArray(raw.quickActions)?raw.quickActions.map((v:any)=>String(v??"").trim()).filter(Boolean).slice(0,4):[];const date=String(raw.date??"").trim();if(content||quickActions.length||date)bonus={content,quickActions,date};}}catch{}
  return {taskCount,requiredDepositCents:clampMoneyCents(Number(parsed.requiredDepositCents??0)),amountCents:clampMoneyCents(Number(parsed.amountCents??0)),vipLevel,resetCount:Math.max(0,Math.min(100000,Math.trunc(Number(parsed.resetCount??0)))),cycleStartSequence:Math.max(1,Math.trunc(Number(cycleRow?.value||parsed.cycleStartSequence||1))),combinationTaskCount:sequences.length,combinationTaskAmountCents:clampMoneyCents(Number(parsed.combinationTaskAmountCents??0)),combinationTaskSequences:sequences,combinationCommissionRateBps:1500,combinationTaskRound:Math.max(1,Math.min(100,Math.trunc(Number(parsed.combinationTaskRound??1)))),bonus};
}
async function saveTaskManagementConfig(db:any,clientId:string,config:TaskManagementConfig){
  await db.setting.upsert({where:{key:taskConfigKey(clientId)},create:{id:await uniqueSettingId(),key:taskConfigKey(clientId),value:JSON.stringify(config)},update:{value:JSON.stringify(config)}});
  await db.setting.upsert({where:{key:taskCycleKey(clientId)},create:{id:await uniqueSettingId(),key:taskCycleKey(clientId),value:String(config.cycleStartSequence)},update:{value:String(config.cycleStartSequence)}});
}
function requiredWatchSeconds(durationSeconds:number){const configured=Number(process.env.TASK_REQUIRED_WATCH_SECONDS||2.5);const target=Number.isFinite(configured)&&configured>0?configured:2.5;return durationSeconds>0?Math.min(target,durationSeconds):target;}
async function taskPriceConfig(){
  const keys=["task_price_min_percent","task_price_max_percent","task_price_min_absolute_cents","task_price_max_absolute_cents","task_price_min_remaining_balance_cents"];
  const rows=await prisma.setting.findMany({where:{key:{in:keys}}});
  const values=new Map(rows.map(r=>[r.key,Number(r.value)]));
  const num=(key:string,fallback:number)=>{const db=values.get(key);const envKey=key.toUpperCase();const env=Number(process.env[envKey]);return Number.isFinite(db??NaN)?Number(db):Number.isFinite(env)?env:fallback;};
  return {
    minPercent:Math.max(6,num("task_price_min_percent",6)),
    maxPercent:Math.max(0,num("task_price_max_percent",10)),
    minAbsoluteCents:Math.max(1,Math.round(num("task_price_min_absolute_cents",1))),
    maxAbsoluteCents:Math.max(1,Math.round(num("task_price_max_absolute_cents",100000))),
    minRemainingBalanceCents:Math.max(0,Math.round(num("task_price_min_remaining_balance_cents",0)))
  };
}
function secureRandomCents(min:number,max:number){
  if(max<=min)return min;
  return min+randomInt(max-min+1);
}
async function randomTaskAmount(balanceCents:number,frozenCents=0){
  const cfg=await taskPriceConfig();
  const currentBalance=Math.max(0,Math.floor(balanceCents));
  const availableBalance=Math.max(0,currentBalance-Math.max(0,Math.floor(frozenCents)));
  const safeMax=Math.min(availableBalance-cfg.minRemainingBalanceCents,cfg.maxAbsoluteCents,Math.floor(currentBalance*cfg.maxPercent/100));
  const safeMin=Math.max(cfg.minAbsoluteCents,Math.ceil(currentBalance*cfg.minPercent/100));
  if(currentBalance<=0||safeMax<safeMin)return null;
  return secureRandomCents(safeMin,safeMax);
}
async function upsertDefaultTaskPriceSettings(){
  const defaults:{key:string;value:string}[]=[
    {key:"task_price_min_percent",value:"6"},
    {key:"task_price_max_percent",value:"10"},
    {key:"task_price_min_absolute_cents",value:"1"},
    {key:"task_price_max_absolute_cents",value:"100000"},
    {key:"task_price_min_remaining_balance_cents",value:"0"}
  ];
  for(const item of defaults)await prisma.setting.upsert({where:{key:item.key},create:{id:await uniqueSettingId(),key:item.key,value:item.value},update:{}});
}
async function upsertDefaultVipRules(){
  const defaults:[string,VipRule][]=[
    ["VIP1",{taskCount:30,commissionRateBps:70}],
    ["VIP2",{taskCount:40,commissionRateBps:80}],
    ["VIP3",{taskCount:50,commissionRateBps:140}],
    ["VIP4",{taskCount:60,commissionRateBps:160}]
  ];
  for(const [vip,rule] of defaults)await prisma.setting.upsert({where:{key:vipRuleKey(vip)},create:{id:await uniqueSettingId(),key:vipRuleKey(vip),value:JSON.stringify(rule)},update:{}});
}
function taskPublic(t:any,includeValues=false){
  const completed=String(t.status||"")===TaskStatus.COMPLETED;
  const hasAssignedVideo=Boolean(t.videoId);
  const movieTitle=normalizeMovieTitle(String(t.movieTitle||t.videoTitle||t.title||"").trim());
  const moviePosterUrl=String(t.moviePosterUrl||"").trim();
  const movieReleaseDate=t.movieReleaseDate||t.videoPublishedAt||null;
  const videoSource=hasAssignedVideo&&String(t.videoProvider||"youtube")==="youtube"?"https://www.youtube-nocookie.com/embed/"+encodeURIComponent(String(t.videoId)):null;
  return {
    id:t.id,sequence:t.sequence,sessionId:t.sessionId??null,sessionGeneratedTaskCount:t.session?.generatedTaskCount??null,taskType:t.taskType||"STANDARD",commissionRateBps:t.commissionRateBps??0,title:t.title,status:t.status,isLucky:t.isLucky,createdAt:t.createdAt,videoId:t.videoId??null,videoTitle:t.videoTitle??null,movieTitle,moviePosterUrl,videoThumbnailUrl:t.videoThumbnailUrl??null,
    revealedAt:t.revealedAt,completedAt:t.completedAt,rating:t.rating??null,
    requiredWatchSeconds:t.requiredWatchSeconds??2.5,watchSeconds:Math.max(0,Number(t.watchAccumulatedMs||0))/1000,
    movie:(hasAssignedVideo||t.movieTitle||t.moviePosterUrl)?{id:t.movieId??null,title:movieTitle,posterUrl:moviePosterUrl,releaseDate:movieReleaseDate}:null,
    video:hasAssignedVideo?{
      provider:t.videoProvider||"youtube",videoId:t.videoId,title:t.videoTitle||movieTitle,
      source:videoSource,videoUrl:videoSource,playable:true,
      channelId:t.videoChannelId||"",channelTitle:t.videoChannelTitle||"",thumbnailUrl:t.videoThumbnailUrl||null,
      durationSeconds:t.videoDurationSeconds??0,publishedAt:t.videoPublishedAt,categoryId:t.videoCategoryId||"",
      viewCount:t.videoViewCount??0,likeCount:t.videoLikeCount??0,commentCount:t.videoCommentCount??0,liveBroadcastContent:t.videoLiveBroadcastContent||"none"
    }:null,
    ...((includeValues||completed||t.revealedAt)?{
      amountCents:Math.max(0,Number(t.amountCents||0)),
      commissionCents:Math.max(0,Number(t.commissionCents||0)),
      movieTitle, trailerTitle:t.videoTitle||movieTitle, thumbnail:moviePosterUrl,
      channel:t.videoChannelTitle||"",publishedAt:t.videoPublishedAt||movieReleaseDate,duration:t.videoDurationSeconds??0,
      price:Math.max(0,Number(t.amountCents||0)),commission:Math.max(0,Number(t.commissionCents||0))
    }: {})
  };
}
function staffWhere(role:Role,id:string){return role===Role.OWNER?{role:Role.CLIENT}:{role:Role.CLIENT,adminId:id};}
function canManageClient(role:Role,id:string,clientId:string){return prisma.user.findFirst({where:{id:clientId,role:Role.CLIENT,...(role===Role.ADMIN?{adminId:id}:{})}});}

let applicationReady=false;let migrationProcess:ChildProcess|null=null;

app.get("/",(_req,res)=>res.json({ok:true,service:"box-office-mojo-api",status:"alive",time:new Date().toISOString()}));
app.get("/health",(_req,res)=>res.json({ok:true,service:"box-office-mojo-api",status:"alive",time:new Date().toISOString()}));
app.get("/api/health",(_req,res)=>res.json({ok:true,service:"box-office-mojo-api",status:"alive",time:new Date().toISOString()}));
app.get("/ready",async(_req,res)=>{if(!applicationReady)return res.status(503).json({ok:false,status:"starting",database:"not-ready"});try{await prisma.$queryRaw`SELECT 1`;return res.json({ok:true,status:"ready",database:"ok"});}catch{return res.status(503).json({ok:false,status:"not-ready",database:"unavailable"});}});
app.get("/api/ready",async(_req,res)=>{if(!applicationReady)return res.status(503).json({ok:false,status:"starting",database:"not-ready"});try{await prisma.$queryRaw`SELECT 1`;return res.json({ok:true,status:"ready",database:"ok"});}catch{return res.status(503).json({ok:false,status:"not-ready",database:"unavailable"});}});
app.use((req,res,next)=>{if(!req.path.startsWith("/api/")||req.path.endsWith("/health")||req.path.endsWith("/ready"))return next();if(applicationReady)return next();const authPath=["/api/auth/login","/api/auth/register"].includes(req.path);if(authPath)return prisma.$queryRaw`SELECT 1`.then(()=>next()).catch(()=>res.status(503).json({error:"The service is still connecting to its database.",code:"DATABASE_STARTING"}));return res.status(503).json({error:"The service is getting ready. Please try again in a moment.",code:"SERVICE_STARTING"});});

app.post("/api/auth/register",asyncRoute(async(req,res)=>{
  const d=registerSchema.parse(req.body);const identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;
  if(await prisma.user.findUnique({where:{identifier}}))return res.status(409).json({error:"That email or phone number is already in use."});
  const admin=await prisma.user.findUnique({where:{inviteCode:d.inviteCode},select:{id:true,role:true,active:true}});
  if(!admin||admin.role!==Role.ADMIN||!admin.active)return res.status(400).json({error:"That invite code is unavailable. Please ask your administrator for an active invite code."});
  const user=await prisma.$transaction(async tx=>{const u=await tx.user.create({data:{id:await uniqueUserId(),name:d.name,identifier,identifierType:detectIdentifier(identifier),passwordHash:await hashPassword(d.password),withdrawalPasswordHash:await hashPassword(d.withdrawalPassword),role:Role.CLIENT,adminId:admin.id,balanceCents:1000,welcomeBonusGrantedAt:new Date()}});await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:u.id,amountCents:1000,type:"WELCOME_BONUS",note:"Welcome balance"}});return u;});
  await audit(undefined,user.id,"CLIENT_REGISTERED",{adminId:admin.id}); const token=issueToken({id:user.id,role:user.role});return res.status(201).json({token,user:safeUser(user),message:"Your account is ready. Your welcome balance has been added."});
}));
app.post("/api/auth/login",asyncRoute(async(req,res)=>{const d=loginSchema.parse(req.body);const identifier=d.identifier.trim().includes("@")?d.identifier.trim().toLowerCase():d.identifier.trim();const user=await prisma.user.findUnique({where:{identifier}});if(!user)return res.status(401).json({error:"We could not find an account with that email or phone number."});if(!user.active)return res.status(403).json({error:"This account is currently paused. Please contact the workspace owner."});if(!(await verifyPassword(d.password,user.passwordHash)))return res.status(401).json({error:"The password does not match this account."});const token=issueToken({id:user.id,role:user.role});return res.json({token,user:safeUser(user),message:"Welcome back."});}));
app.get("/api/me",auth(),asyncRoute(async(_req,res)=>{const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});res.json({user:safeUser(u)});}));

const SYSTEM_STATUS_KEY="system_status";
async function readSystemEnabled(){const setting=await prisma.setting.findUnique({where:{key:SYSTEM_STATUS_KEY}});return setting?setting.value!=="false":true;}
app.get("/api/system/status",auth([Role.OWNER,Role.ADMIN]),asyncRoute(async(_req,res)=>{res.json({enabled:await readSystemEnabled(),source:"backend"});}));
app.patch("/api/system/status",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const d=z.object({enabled:z.boolean()}).parse(req.body);const setting=await prisma.setting.upsert({where:{key:SYSTEM_STATUS_KEY},create:{id:await uniqueSettingId(),key:SYSTEM_STATUS_KEY,value:String(d.enabled)},update:{value:String(d.enabled)}});await audit(res.locals.auth.sub,undefined,"SYSTEM_STATUS_CHANGED",{enabled:d.enabled});res.json({enabled:setting.value!=="false",source:"backend"});}));

// A logical platform-off state never shuts down the process. Owner/Admin access remains available,
// while Client business operations are paused until the Owner re-enables the platform.
const platformGuard:express.RequestHandler=async(_req,res,next)=>{try{if(await readSystemEnabled())return next();return res.status(503).json({error:"The platform is temporarily unavailable. Please try again later.",code:"PLATFORM_OFF"});}catch(error){return next(error);}};
const clientAuth=()=>[auth([Role.CLIENT]),platformGuard] as express.RequestHandler[];

app.get("/api/client/support",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{
  const client=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub},select:{adminId:true}});
  const admin=client.adminId?await prisma.user.findFirst({where:{id:client.adminId,role:Role.ADMIN,active:true},select:{id:true,name:true}}):null;
  const setting=admin?await prisma.setting.findUnique({where:{key:`telegram_admin_${admin.id}`}}):null;
  res.json({admin:admin?{id:admin.id,name:admin.name}:null,telegramUsername:setting?.value||null});
}));
app.get("/api/client/movies",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const trailers=await getCurrentTrailerCandidates();res.json({movies:trailers.map(v=>({title:normalizeMovieTitle(v.movieTitle||v.title),movieTitle:normalizeMovieTitle(v.movieTitle||v.title),videoId:v.videoId,posterUrl:v.moviePosterUrl,thumbnailUrl:v.thumbnailUrl,channelTitle:v.channelTitle,publishedAt:v.publishedAt,durationSeconds:v.durationSeconds,viewCount:v.viewCount}))});}));
app.get("/api/client/home",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{
  const userId=res.locals.auth.sub;const config=await getTaskManagementConfig(userId);
  const session=await prisma.taskSession.findFirst({where:{clientId:userId,status:"ACTIVE"},orderBy:{createdAt:"desc"}});
  const tasks=session?await prisma.task.findMany({where:{sessionId:session.id},orderBy:{sequence:"asc"}}):[];
  const [u,txs,messages]=await Promise.all([prisma.user.findUniqueOrThrow({where:{id:userId}}),prisma.walletTransaction.findMany({where:{userId},orderBy:{createdAt:"desc"},take:8}),prisma.message.findMany({where:{OR:[{senderId:userId},{recipientId:userId}]},orderBy:{createdAt:"desc"},take:6})]);const available=Math.max(0,u.balanceCents-(u.frozenCents??0));const nextPending=tasks.find(t=>t.status===TaskStatus.PENDING);const needAmountCents=nextPending&&nextPending.amountCents>available?nextPending.amountCents:0;const vipBenefits=await Promise.all(["VIP1","VIP2","VIP3","VIP4"].map(async vip=>{const rule=await getVipRule(vip);return {vipLevel:vip,taskCount:rule.taskCount,commissionRateBps:rule.commissionRateBps};}));
  res.json({user:safeUser(u),tasks:tasks.map(t=>taskPublic(t,false)),taskConfig:{taskCount:session?.generatedTaskCount??config.taskCount,resetCount:config.resetCount,vipLevel:session?.vipLevel??config.vipLevel,requiredDepositCents:config.requiredDepositCents,amountCents:config.amountCents,combinationTaskCount:config.combinationTaskCount,combinationTaskAmountCents:config.combinationTaskAmountCents,combinationTaskRound:config.combinationTaskRound,bonus:config.bonus,needAmountCents,displayBalanceCents:needAmountCents>0?0:available},vipBenefits,benefitRules:[{days:5,label:"Milestone benefit"},{days:15,label:"Enhanced milestone benefit"},{days:30,label:"Extended milestone benefit"}],transactions:txs,messages});
}));
app.get("/api/client/leaderboard",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{
  const now=new Date();
  const day=now.getUTCDay();
  const daysFromMonday=(day+6)%7;
  const weekStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-daysFromMonday,0,0,0,0));
  const totals=await prisma.walletTransaction.groupBy({
    by:["userId"],
    where:{type:"TASK_COMMISSION",createdAt:{gte:weekStart}},
    _sum:{amountCents:true},
    orderBy:{_sum:{amountCents:"desc"}},
    take:12
  });
  const ids=totals.map(x=>x.userId);
  const users=ids.length?await prisma.user.findMany({where:{id:{in:ids},role:Role.CLIENT,active:true},select:{id:true,name:true}}):[];
  const byId=new Map(users.map(u=>[u.id,u]));
  const mask=(value:string)=>Array.from(String(value||"")).slice(0,2).join("")+"***";
  const entries=totals.map((row,index)=>{
    const user=byId.get(row.userId);
    if(!user)return null;
    return {
      rank:index+1,
      name:mask(user.name),
      uid:mask(user.id),
      rewardCents:Math.max(0,Number(row._sum.amountCents||0))
    };
  }).filter(Boolean);
  res.json({weekStart:weekStart.toISOString(),entries});
}));
app.get("/api/client/wallet",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});const transactions=await prisma.walletTransaction.findMany({where:{userId:u.id},orderBy:{createdAt:"desc"},take:50});res.json({user:safeUser(u),transactions});}));
app.get("/api/client/tasks",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{
  const clientId=res.locals.auth.sub;const config=await getTaskManagementConfig(clientId);
  const session=await prisma.taskSession.findFirst({where:{clientId,status:"ACTIVE"},orderBy:{createdAt:"desc"}});
  const tasks=session?await prisma.task.findMany({where:{sessionId:session.id},orderBy:{sequence:"asc"}}):[];
  const current=tasks.find(t=>t.status===TaskStatus.PENDING&&t.revealedAt)||tasks.find(t=>t.status===TaskStatus.PENDING)||null;
  res.json({tasks:tasks.map(t=>taskPublic(t,false)),current:current?taskPublic(current,false):null,completed:tasks.filter(t=>t.status===TaskStatus.COMPLETED).length,total:session?.generatedTaskCount??config.taskCount,taskConfig:{taskCount:session?.generatedTaskCount??config.taskCount,resetCount:config.resetCount,vipLevel:session?.vipLevel??config.vipLevel,requiredDepositCents:config.requiredDepositCents,amountCents:config.amountCents,combinationTaskCount:config.combinationTaskCount,combinationTaskAmountCents:config.combinationTaskAmountCents}});
}));
app.get("/api/client/history",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const rows=await prisma.task.findMany({where:{clientId:res.locals.auth.sub,status:TaskStatus.COMPLETED},include:{session:{select:{generatedTaskCount:true}}},orderBy:{completedAt:"desc"}});res.json({history:rows.map(t=>taskPublic(t,true))});}));
app.post(["/api/client/tasks","/api/client/tasks/start"],auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const clientId=res.locals.auth.sub;const idempotencyKey=String(req.header("Idempotency-Key")||"").trim();
  const active=await prisma.taskSession.findFirst({where:{clientId,status:"ACTIVE"},orderBy:{createdAt:"desc"}});
  if(active){const pending=await prisma.task.findFirst({where:{sessionId:active.id,status:TaskStatus.PENDING},orderBy:{sequence:"asc"}});if(pending)return res.status(409).json({success:false,code:"PENDING_TASK_EXISTS",message:"You already have an active task session. Please finish the current task first.",task:taskPublic(pending,true),sessionId:active.id});await prisma.taskSession.update({where:{id:active.id},data:{status:"COMPLETED"}});}
  if(idempotencyKey){const prior=await prisma.task.findFirst({where:{clientId,idempotencyKey}});if(prior)return res.json({success:true,task:taskPublic(prior,true),sessionId:prior.sessionId,idempotent:true});}
  const config=await getTaskManagementConfig(clientId);let videos:any[]=[];
  try{videos=await getTrendingVideosForClient(clientId,config.taskCount);}
  catch(error){const code=String((error as any)?.code||"TASK_CREATION_FAILED");console.error("[task-start]",code,error instanceof Error?error.message:error);const unavailable=["YOUTUBE_AUTH_ERROR","YOUTUBE_QUOTA_EXHAUSTED","YOUTUBE_API_ERROR","YOUTUBE_ZERO_RESULTS","YOUTUBE_CANDIDATES_REJECTED","NO_ELIGIBLE_HOLLYWOOD_MOVIE","NO_VALID_CACHED_MOVIE","NO_PLAYABLE_VIDEO","YOUTUBE_DISCOVERY_COOLDOWN"];return res.status(unavailable.includes(code)?503:500).json({success:false,error:"We couldn't prepare your tasks right now. Please try again shortly.",code});}
  try{
    const result=await prisma.$transaction(async tx=>{
      // Serialize STARTING per client so rapid duplicate requests cannot create two active sessions.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${clientId}))`;
      const concurrentActive=await tx.taskSession.findFirst({where:{clientId,status:"ACTIVE"},orderBy:{createdAt:"desc"}});
      if(concurrentActive){
        const concurrentPending=await tx.task.findFirst({where:{sessionId:concurrentActive.id,status:TaskStatus.PENDING},orderBy:{sequence:"asc"}});
        if(concurrentPending)throw Object.assign(new Error("You already have an active task session. Please finish the current task first."),{code:"PENDING_TASK_EXISTS",task:taskPublic(concurrentPending,true),sessionId:concurrentActive.id});
      }
      const user=await tx.user.findUniqueOrThrow({where:{id:clientId},select:{balanceCents:true,frozenCents:true}});
      const available=Math.max(0,user.balanceCents-(user.frozenCents??0));if(available<=0)throw Object.assign(new Error("Your available balance is not enough to prepare tasks. Please add funds before continuing."),{code:"LOW_BALANCE"});
      const ruleRow=await tx.setting.findUnique({where:{key:vipRuleKey(config.vipLevel)}});const fallback=defaultVipRule(config.vipLevel);let vipRule=fallback;try{if(ruleRow){const p=JSON.parse(ruleRow.value||"{}");vipRule={taskCount:clampTaskCount(Number(p.taskCount??fallback.taskCount)),commissionRateBps:clampRateBps(Number(p.commissionRateBps??fallback.commissionRateBps))};}}catch{}
      const sessionId=await uniqueTaskSessionId();const latestTask=await tx.task.findFirst({where:{clientId},select:{sequence:true},orderBy:{sequence:"desc"}});const sequenceStart=Math.max(config.cycleStartSequence,(latestTask?.sequence??0)+1);const amountCfg=await taskPriceConfig();const targetRatio=0.82+secureRandomCents(0,4)/100;const targetExposure=Math.floor(available*targetRatio);let remainingExposure=Math.max(1,targetExposure);const amounts:number[]=[];
      for(let i=0;i<config.taskCount;i++){const remaining=config.taskCount-i;const sequenceNumber=i+1;const isCombination=config.combinationTaskSequences.includes(sequenceNumber);const configured=isCombination&&config.combinationTaskAmountCents>0?config.combinationTaskAmountCents:config.amountCents;
        if(configured>0){amounts.push(configured);remainingExposure=Math.max(0,remainingExposure-configured);continue;}
        const desired=Math.max(amountCfg.minAbsoluteCents,Math.floor(remainingExposure/remaining));const cap=Math.max(1,Math.min(Math.floor(available*amountCfg.maxPercent/100),amountCfg.maxAbsoluteCents));const variance=Math.max(1,Math.round(desired*0.05));const min=Math.max(1,Math.min(desired-variance,cap));const max=Math.max(min,Math.min(desired+variance,cap));const amount=secureRandomCents(min,max);amounts.push(amount);remainingExposure=Math.max(0,remainingExposure-amount);
      }
      const taskData:any[]=[];for(let i=0;i<config.taskCount;i++){const video=videos[i];const sequenceNumber=i+1;const combination=config.combinationTaskSequences.includes(sequenceNumber);const amount=amounts[i];const rateBps=combination?1500:vipRule.commissionRateBps;const commission=Math.max(1,Math.round(amount*rateBps/10000));taskData.push({id:await uniqueTaskId(),clientId,sessionId,sequence:sequenceStart+i,title:normalizeMovieTitle(video.movieTitle||video.title),taskType:combination?"COMBINATION":"STANDARD",commissionRateBps:rateBps,amountCents:amount,commissionCents:commission,isLucky:combination,videoProvider:video.provider,videoId:video.videoId,videoTitle:video.title,movieTitle:video.movieTitle,moviePosterUrl:video.moviePosterUrl,movieReleaseDate:video.movieReleaseDate?new Date(video.movieReleaseDate):null,requiredWatchSeconds:requiredWatchSeconds(video.durationSeconds),videoChannelId:video.channelId||null,videoChannelTitle:video.channelTitle,videoThumbnailUrl:video.thumbnailUrl,videoDurationSeconds:video.durationSeconds,videoPublishedAt:video.publishedAt?new Date(video.publishedAt):null,videoCategoryId:video.categoryId,videoViewCount:video.viewCount??0,videoLikeCount:video.likeCount??0,videoCommentCount:video.commentCount??0,videoLiveBroadcastContent:video.liveBroadcastContent||"none",idempotencyKey:i===0&&idempotencyKey?idempotencyKey:null});}
      const totalAmount=amounts.reduce((n,v)=>n+v,0);const totalCommission=taskData.reduce((n,v)=>n+v.commissionCents,0);await tx.setting.upsert({where:{key:taskCycleKey(clientId)},create:{id:await uniqueSettingId(),key:taskCycleKey(clientId),value:String(sequenceStart+config.taskCount)},update:{value:String(sequenceStart+config.taskCount)}});
      const session=await tx.taskSession.create({data:{id:sessionId,clientId,vipLevel:config.vipLevel,balanceSnapshotCents:user.balanceCents,generatedTaskCount:config.taskCount,totalTaskAmountCents:totalAmount,totalExpectedCommissionCents:totalCommission,resetNumber:config.resetCount,taskCountOverride:config.taskCount,amountOverrideCents:config.amountCents||null,combinationTaskCount:config.combinationTaskCount,combinationTaskAmountCents:config.combinationTaskAmountCents,combinationCommissionRateBps:1500}});
      const taskRows:any[]=[];for(const data of taskData)taskRows.push(await tx.task.create({data}));
      return {session,tasks:taskRows};
    },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
    const first=await prisma.task.update({where:{id:result.tasks[0].id},data:{revealedAt:new Date(),watchAccumulatedMs:0,watchHeartbeatAt:null}});
    return res.status(201).json({success:true,session:{id:result.session.id,vipLevel:result.session.vipLevel,balanceSnapshotCents:result.session.balanceSnapshotCents,generatedTaskCount:result.session.generatedTaskCount,resetNumber:result.session.resetNumber,totalTaskAmountCents:result.session.totalTaskAmountCents,totalExpectedCommissionCents:result.session.totalExpectedCommissionCents},tasks:result.tasks.map(t=>taskPublic(t,false)),task:taskPublic(first,true),taskConfig:{taskCount:result.session.generatedTaskCount,resetCount:config.resetCount,vipLevel:config.vipLevel,requiredDepositCents:config.requiredDepositCents,amountCents:config.amountCents,combinationTaskCount:config.combinationTaskCount,combinationTaskAmountCents:config.combinationTaskAmountCents}});
  }catch(error){const code=String((error as any)?.code||"TASK_CREATION_FAILED");console.error("[task-start]",{operation:"task-start",code,error:error instanceof Error?error.message:String(error)});if(code==="PENDING_TASK_EXISTS")return res.status(409).json({success:false,error:"You already have an active task session. Please finish the current task first.",code,task:(error as any).task??null,sessionId:(error as any).sessionId??null});const unavailable=["YOUTUBE_AUTH_ERROR","YOUTUBE_QUOTA_EXHAUSTED","YOUTUBE_API_ERROR","YOUTUBE_ZERO_RESULTS","YOUTUBE_CANDIDATES_REJECTED","NO_ELIGIBLE_HOLLYWOOD_MOVIE","NO_VALID_CACHED_MOVIE","NO_PLAYABLE_VIDEO","NO_PLAYABLE_MOVIE_VIDEO","VIDEO_NOT_PLAYABLE","VIDEO_NOT_EMBEDDABLE","VIDEO_UNAVAILABLE","POSTER_UNAVAILABLE","MOVIE_NOT_FOUND","YOUTUBE_DISCOVERY_COOLDOWN"];return res.status(unavailable.includes(code)?503:(code==="LOW_BALANCE"||code==="TASK_AMOUNT_INVALID"?409:500)).json({success:false,error:"We couldn't prepare your movie right now. Please try again shortly.",code});}
}));
app.post("/api/client/tasks/:id/reveal",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const clientId=res.locals.auth.sub;
  const [task,user]=await Promise.all([
    prisma.task.findFirst({where:{id,clientId}}),
    prisma.user.findUniqueOrThrow({where:{id:clientId},select:{balanceCents:true,frozenCents:true}})
  ]);
  const availableBalanceCents=Math.max(0,user.balanceCents-(user.frozenCents??0));
  if(!task)return res.status(404).json({error:"Task not found."});
  const config=await getTaskManagementConfig(clientId);
  const activeSession=await prisma.taskSession.findFirst({where:{clientId,status:"ACTIVE"},orderBy:{createdAt:"desc"}});const first=activeSession?await prisma.task.findFirst({where:{sessionId:activeSession.id,status:TaskStatus.PENDING},orderBy:{sequence:"asc"}}):null;
  if(!first||first.id!==task.id)return res.status(409).json({error:"Please finish your current task before opening another one."});
  let updated=task;
  if(!task.revealedAt){
    const amount=await randomTaskAmount(user.balanceCents,user.frozenCents);
    if(amount===null)return res.status(409).json({error:"Your balance is too low to start this task. Please add funds before continuing."});
    try{
      const video=await getAlternativeVideoForTask(clientId,task.movieTitle||null,task.videoId||null);
      updated=await prisma.task.update({where:{id},data:{
        amountCents:amount,commissionCents:defaultCommission(amount,user.balanceCents),revealedAt:new Date(),
        videoProvider:video.provider,videoId:video.videoId,videoTitle:video.title,movieTitle:video.movieTitle,moviePosterUrl:video.moviePosterUrl,movieReleaseDate:video.movieReleaseDate?new Date(video.movieReleaseDate):null,videoChannelId:video.channelId||null,videoChannelTitle:video.channelTitle,
        videoThumbnailUrl:video.thumbnailUrl,videoDurationSeconds:video.durationSeconds,
        videoPublishedAt:video.publishedAt?new Date(video.publishedAt):null,videoCategoryId:video.categoryId,
        videoViewCount:video.viewCount??0,videoLikeCount:video.likeCount??0,videoCommentCount:video.commentCount??0,videoLiveBroadcastContent:video.liveBroadcastContent||"none"
      }});
    }catch(error){
      const message=error instanceof Error?error.message:"Trending videos are temporarily unavailable.";
      return res.status(503).json({error:message,code:"TRENDING_VIDEO_UNAVAILABLE"});
    }
  }else if(task.amountCents>availableBalanceCents){
    return res.status(409).json({error:"Your available balance is not enough for this task. Please add funds before continuing."});
  }else if(!task.videoId){
    try{
      const video=await getTrendingVideoForClient(clientId);
      updated=await prisma.task.update({where:{id},data:{
        videoProvider:video.provider,videoId:video.videoId,videoTitle:video.title,videoChannelTitle:video.channelTitle,
        videoThumbnailUrl:video.thumbnailUrl,videoDurationSeconds:video.durationSeconds,
        videoPublishedAt:video.publishedAt?new Date(video.publishedAt):null,videoCategoryId:video.categoryId
      }});
    }catch{return res.status(503).json({error:"This video isn't available right now. We're loading another one.",code:"TRENDING_VIDEO_UNAVAILABLE"});}
  }
  res.json({task:taskPublic(updated,true)});
}));
app.post("/api/client/tasks/:id/video-retry",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const clientId=res.locals.auth.sub;
  const task=await prisma.task.findFirst({where:{id,clientId,status:TaskStatus.PENDING}});
  if(!task)return res.status(404).json({error:"Task not found."});
  if(!task.revealedAt)return res.status(400).json({error:"Open the task details first."});
  try{
    const video=await getTrendingVideoForClient(clientId);
    const updated=await prisma.task.update({where:{id},data:{
      videoProvider:video.provider,videoId:video.videoId,videoTitle:video.title,movieTitle:video.movieTitle,moviePosterUrl:video.moviePosterUrl,movieReleaseDate:video.movieReleaseDate?new Date(video.movieReleaseDate):null,videoChannelId:video.channelId||null,videoChannelTitle:video.channelTitle,
      videoThumbnailUrl:video.thumbnailUrl,videoDurationSeconds:video.durationSeconds,
      videoPublishedAt:video.publishedAt?new Date(video.publishedAt):null,videoCategoryId:video.categoryId,
      videoViewCount:video.viewCount??0,videoLikeCount:video.likeCount??0,videoCommentCount:video.commentCount??0,videoLiveBroadcastContent:video.liveBroadcastContent||"none"
    }});
    res.json({task:taskPublic(updated,true)});
  }catch{return res.status(503).json({error:"This video isn't available right now. We're loading another one.",code:"TRENDING_VIDEO_UNAVAILABLE"});}
}));
app.post("/api/client/tasks/:id/watch",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const clientId=res.locals.auth.sub;const d=z.object({playing:z.boolean()}).parse(req.body||{});
  const task=await prisma.task.findFirst({where:{id,clientId,status:TaskStatus.PENDING}});
  if(!task||!task.revealedAt||!task.videoId)return res.status(404).json({error:"Task not found."});
  const now=new Date();const previous=task.watchHeartbeatAt;let accumulated=task.watchAccumulatedMs||0;
  if(previous){accumulated=Math.min(600000,accumulated+Math.max(0,Math.min(3500,now.getTime()-previous.getTime())));}
  const updated=await prisma.task.update({where:{id},data:{watchAccumulatedMs:accumulated,watchHeartbeatAt:d.playing?now:null}});
  res.json({success:true,watchSeconds:updated.watchAccumulatedMs/1000,requiredWatchSeconds:updated.requiredWatchSeconds});
}));
app.post("/api/client/tasks/:id/complete",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const clientId=res.locals.auth.sub;
  const d=z.object({rating:z.coerce.number().int().min(1).max(5).nullable().optional(),watchedSeconds:z.coerce.number().finite().min(0).optional()}).parse(req.body||{});
  const task=await prisma.task.findFirst({where:{id,clientId}});
  if(!task)return res.status(404).json({error:"Task not found."});
  const config=await getTaskManagementConfig(clientId);
  const first=await prisma.task.findFirst({where:{clientId,status:TaskStatus.PENDING,sequence:{gte:config.cycleStartSequence,lt:config.cycleStartSequence+config.taskCount}},orderBy:{sequence:"asc"}});
  if(!first||first.id!==task.id)return res.status(409).json({error:"Please finish your current task before continuing."});
  if(!task.revealedAt)return res.status(400).json({error:"Open the task details first."});
  if(!task.videoId)return res.status(400).json({error:"A valid video has not been assigned to this task yet.",code:"NO_PLAYABLE_VIDEO"});
  const requiredMs=Math.round(Math.max(0,Number(task.requiredWatchSeconds||2.5))*1000);const serverWatchedMs=Math.max(0,Number(task.watchAccumulatedMs||0));const elapsedSinceRevealMs=task.revealedAt?Math.max(0,Date.now()-task.revealedAt.getTime()):0;
  if(requiredMs>0){if(serverWatchedMs<requiredMs)return res.status(409).json({error:"Please watch at least "+Number(task.requiredWatchSeconds||2.5)+" seconds of the trailer before submitting this task.",code:"WATCH_TIME_INCOMPLETE"});if(serverWatchedMs>elapsedSinceRevealMs+1500)return res.status(409).json({error:"Please keep watching the trailer normally before submitting this task.",code:"WATCH_TIME_INVALID"});}
  const currentAvailable=await prisma.user.findUniqueOrThrow({where:{id:clientId},select:{balanceCents:true,frozenCents:true}});const currentAvailableCents=Math.max(0,currentAvailable.balanceCents-(currentAvailable.frozenCents??0));if(currentAvailableCents<task.amountCents)return res.status(409).json({success:false,error:"Additional balance is required to complete this task.",code:"NEED_AMOUNT",requiredAmountCents:task.amountCents,availableAmountCents:currentAvailableCents});
  const result=await prisma.$transaction(async tx=>{
    const fresh=await tx.task.findUniqueOrThrow({where:{id}});
    if(fresh.status!==TaskStatus.PENDING)throw new Error("This task has already been completed.");
    const requiredMs=Math.round(Math.max(0,Number(fresh.requiredWatchSeconds||2.5))*1000);
    if(requiredMs>0&&Number(fresh.watchAccumulatedMs||0)<requiredMs)throw new Error("Please watch the trailer for the required time before submitting this task.");
    const before=await tx.user.findUniqueOrThrow({where:{id:clientId},select:{balanceCents:true,frozenCents:true}});
    const beforeAvailable=Math.max(0,before.balanceCents-(before.frozenCents??0));
    if(beforeAvailable<fresh.amountCents)throw Object.assign(new Error("Your available balance is not enough for this task. Please add funds before finishing it."),{code:"NEED_AMOUNT",requiredAmountCents:fresh.amountCents,availableAmountCents:beforeAvailable});
    const user=await tx.user.update({where:{id:clientId},data:{balanceCents:{increment:fresh.commissionCents}}});
    const completed=await tx.task.update({where:{id},data:{status:TaskStatus.COMPLETED,completedAt:new Date(),rating:d.rating??fresh.rating}});
    if(fresh.sessionId){const pendingCount=await tx.task.count({where:{sessionId:fresh.sessionId,status:TaskStatus.PENDING}});await tx.taskSession.update({where:{id:fresh.sessionId},data:{completedTaskCount:{increment:1},status:pendingCount<=1?"COMPLETED":"ACTIVE"}});}
    await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:clientId,amountCents:fresh.commissionCents,type:"TASK_COMMISSION",note:`Task #${fresh.sequence} commission` }});
    return {user,task:completed};
  });
  res.json({user:safeUser(result.user),task:taskPublic(result.task,true),message:"Task completed and your balance has been updated."});
}));
app.get("/api/client/messages",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{const messages=await prisma.message.findMany({where:{OR:[{senderId:res.locals.auth.sub},{recipientId:res.locals.auth.sub}]},orderBy:{createdAt:"asc"}});res.json({messages});}));
app.post("/api/client/messages",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{const d=messageSchema.parse(req.body);const sender=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub},select:{adminId:true}});const recipient=d.recipientId?await prisma.user.findFirst({where:{id:d.recipientId,role:{in:[Role.ADMIN,Role.OWNER]},active:true}}):sender.adminId?await prisma.user.findFirst({where:{id:sender.adminId,role:Role.ADMIN,active:true}}):null;if(!recipient)return res.status(400).json({error:"Your account is not currently connected to an active administrator."});const msg=await prisma.message.create({data:{id:await uniqueMessageId(),senderId:res.locals.auth.sub,recipientId:recipient.id,subject:d.subject,body:d.body}});res.status(201).json({message:msg});}));
app.get("/api/client/account",auth([Role.CLIENT]),asyncRoute(async(_req,res)=>{
  const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});
  const wallet=await prisma.setting.findUnique({where:{key:`wallet_client_${u.id}`}});
  res.json({user:safeUser(u),walletAddress:wallet?.value||""});
}));
app.patch("/api/client/account/password",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const d=z.object({currentPassword:z.string().min(1).max(100),newPassword:z.string().min(6).max(100)}).parse(req.body);
  const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});
  if(!(await verifyPassword(d.currentPassword,u.passwordHash)))return res.status(400).json({error:"Your current password is not correct."});
  await prisma.user.update({where:{id:u.id},data:{passwordHash:await hashPassword(d.newPassword)}});
  await audit(u.id,u.id,"CLIENT_LOGIN_PASSWORD_CHANGED");
  res.json({message:"Login password updated successfully."});
}));
app.patch("/api/client/account/withdrawal-password",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const d=z.object({currentPassword:z.string().min(1).max(100),newPassword:z.string().min(6).max(100)}).parse(req.body);
  const u=await prisma.user.findUniqueOrThrow({where:{id:res.locals.auth.sub}});
  if(!u.withdrawalPasswordHash||!(await verifyPassword(d.currentPassword,u.withdrawalPasswordHash)))return res.status(400).json({error:"Your current withdrawal password is not correct."});
  await prisma.user.update({where:{id:u.id},data:{withdrawalPasswordHash:await hashPassword(d.newPassword)}});
  await audit(u.id,u.id,"CLIENT_WITHDRAWAL_PASSWORD_CHANGED");
  res.json({message:"Withdrawal password updated successfully."});
}));
app.patch("/api/client/account/wallet",auth([Role.CLIENT]),asyncRoute(async(req,res)=>{
  const d=z.object({address:z.string().trim().min(3).max(160)}).parse(req.body);
  const key=`wallet_client_${res.locals.auth.sub}`;
  const setting=await prisma.setting.upsert({where:{key},create:{id:await uniqueSettingId(),key,value:d.address},update:{value:d.address}});
  await audit(res.locals.auth.sub,res.locals.auth.sub,"CLIENT_WALLET_UPDATED");
  res.json({walletAddress:setting.value,message:"Wallet address saved successfully."});
}));

const staff=[Role.OWNER,Role.ADMIN];
app.get("/api/admin/task-price-config",auth(staff),asyncRoute(async(_req,res)=>{const c=await taskPriceConfig();res.json({config:{minPercent:c.minPercent,maxPercent:c.maxPercent,minAbsoluteCents:c.minAbsoluteCents,maxAbsoluteCents:c.maxAbsoluteCents,minRemainingBalanceCents:c.minRemainingBalanceCents}});}));
app.patch("/api/admin/task-price-config",auth(staff),asyncRoute(async(req,res)=>{const d=z.object({minPercent:z.coerce.number().min(0).max(100),maxPercent:z.coerce.number().min(0).max(100),minAbsoluteCents:z.coerce.number().int().min(1).max(100000000),maxAbsoluteCents:z.coerce.number().int().min(1).max(100000000),minRemainingBalanceCents:z.coerce.number().int().min(0).max(100000000)}).parse(req.body||{});if(d.maxPercent<d.minPercent||d.maxAbsoluteCents<d.minAbsoluteCents)return res.status(400).json({error:"Maximum price settings must be greater than or equal to minimum price settings."});const map:{field:keyof typeof d;key:string}[]=[{field:"minPercent",key:"task_price_min_percent"},{field:"maxPercent",key:"task_price_max_percent"},{field:"minAbsoluteCents",key:"task_price_min_absolute_cents"},{field:"maxAbsoluteCents",key:"task_price_max_absolute_cents"},{field:"minRemainingBalanceCents",key:"task_price_min_remaining_balance_cents"}];for(const item of map)await prisma.setting.upsert({where:{key:item.key},create:{id:await uniqueSettingId(),key:item.key,value:String(d[item.field])},update:{value:String(d[item.field])}});await audit(res.locals.auth.sub,undefined,"TASK_PRICE_CONFIG_UPDATED",{fields:Object.keys(d)});res.json({config:await taskPriceConfig(),message:"Task price settings saved."});}));
app.get("/api/admin/trending-config",auth(staff),asyncRoute(async(_req,res)=>{res.json({config:await trendingConfig()});}));
app.patch("/api/admin/trending-config",auth(staff),asyncRoute(async(req,res)=>{
  const d=z.object({
    enabled:z.boolean().optional(),regionCode:z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),categoryId:z.string().trim().min(1).max(10).optional(),
    cacheTtlMinutes:z.coerce.number().int().min(1).max(1440).optional(),poolSize:z.coerce.number().int().min(5).max(50).optional(),
    recentHistorySize:z.coerce.number().int().min(1).max(50).optional(),minimumDurationSeconds:z.coerce.number().int().min(0).max(86400).optional(),
    maximumDurationSeconds:z.coerce.number().int().min(0).max(86400).optional(),freshnessDays:z.coerce.number().int().min(0).max(3650).optional(),discoveryQueries:z.string().trim().max(2000).optional()
  }).parse(req.body||{});
  const map:any={enabled:"trending_videos_enabled",regionCode:"trending_region_code",categoryId:"trending_category_id",cacheTtlMinutes:"trending_cache_ttl_minutes",poolSize:"trending_pool_size",recentHistorySize:"trending_recent_history_size",minimumDurationSeconds:"trending_min_duration_seconds",maximumDurationSeconds:"trending_max_duration_seconds",freshnessDays:"trending_freshness_days",discoveryQueries:"trending_discovery_queries"};
  for(const [field,key] of Object.entries(map) as Array<[string,string]>){
    const value=(d as any)[field];
    if(value!==undefined)await prisma.setting.upsert({where:{key},create:{id:await uniqueSettingId(),key,value:String(value)},update:{value:String(value)}});
  }
  await audit(res.locals.auth.sub,undefined,"TRENDING_CONFIG_UPDATED",{fields:Object.keys(d)});
  res.json({config:await trendingConfig(),message:"Trending video settings saved."});
}));
app.get("/api/admin/dashboard",auth(staff),asyncRoute(async(_req,res)=>{const role=res.locals.auth.role;const where=staffWhere(role,res.locals.auth.sub);const requestWhere=(type:string)=>({status:MessageStatus.OPEN,subject:type,...(role===Role.ADMIN?{OR:[{recipientId:res.locals.auth.sub},{sender:{adminId:res.locals.auth.sub}}]}:{})});const [clients,admins,messages,pendingTasks,completedTasks,depositRequests,withdrawRequests]=await Promise.all([prisma.user.count({where:{...where,active:true}}),prisma.user.count({where:{role:Role.ADMIN,active:true}}),prisma.message.count({where:role===Role.OWNER?{status:{in:[MessageStatus.OPEN,MessageStatus.REPLIED]}}:{status:{in:[MessageStatus.OPEN,MessageStatus.REPLIED]},OR:[{recipientId:res.locals.auth.sub},{sender:{adminId:res.locals.auth.sub}}]}}),prisma.task.count({where:{status:TaskStatus.PENDING,...(role===Role.ADMIN?{client:{adminId:res.locals.auth.sub}}:{})}}),prisma.task.count({where:{status:TaskStatus.COMPLETED,...(role===Role.ADMIN?{client:{adminId:res.locals.auth.sub}}:{})}}),prisma.message.count({where:requestWhere("DEPOSIT_REQUEST")}),prisma.message.count({where:requestWhere("WITHDRAW_REQUEST")})]);res.json({clients,admins,messages,pendingTasks,completedTasks,depositRequests,withdrawRequests});}));
app.get("/api/admin/clients",auth(staff),asyncRoute(async(_req,res)=>{
  const role=res.locals.auth.role;const clients=await prisma.user.findMany({where:staffWhere(role,res.locals.auth.sub),orderBy:{createdAt:"desc"}});
  const rows=await Promise.all(clients.map(async client=>{
    const config=await getTaskManagementConfig(client.id);
    const session=await prisma.taskSession.findFirst({where:{clientId:client.id},orderBy:{createdAt:"desc"}});
    const tasks=session?await prisma.task.findMany({where:{sessionId:session.id}}):[];
    return {...safeUser(client),taskManagement:{taskCount:config.taskCount,sessionTaskCount:session?.generatedTaskCount??null,completedTasks:tasks.filter(t=>t.status===TaskStatus.COMPLETED).length,remainingTasks:tasks.filter(t=>t.status===TaskStatus.PENDING).length,resetCount:config.resetCount,vipLevel:config.vipLevel,requiredDepositCents:config.requiredDepositCents,amountCents:config.amountCents,combinationTaskCount:config.combinationTaskCount,combinationTaskAmountCents:config.combinationTaskAmountCents,combinationTaskSequences:config.combinationTaskSequences,combinationCommissionRateBps:1500,sessionId:session?.id??null}};
  }));
  res.json({clients:rows});
}));
app.get("/api/admin/balances",auth([Role.ADMIN]),asyncRoute(async(_req,res)=>{
  const clients=await prisma.user.findMany({where:{role:Role.CLIENT,adminId:res.locals.auth.sub},orderBy:{createdAt:"desc"}});
  res.json({balances:clients.map(u=>({...safeUser(u),availableCents:Math.max(0,u.balanceCents-(u.frozenCents??0))}))});
}));

app.patch("/api/admin/balances/:id",auth([Role.ADMIN]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const d=z.object({frozenCents:z.coerce.number().int().min(0).max(100000000).optional(),creditScore:z.coerce.number().int().min(0).max(10000).optional()}).refine(v=>v.frozenCents!==undefined||v.creditScore!==undefined,{message:"Please provide a balance control value."}).parse(req.body||{});
  const current=await prisma.user.findFirst({where:{id,role:Role.CLIENT,adminId:res.locals.auth.sub}});
  if(!current)return res.status(404).json({error:"Client not found in your workspace."});
  if(d.frozenCents!==undefined&&d.frozenCents>current.balanceCents)return res.status(400).json({error:"Frozen amount cannot be greater than the current account balance."});
  const u=await prisma.user.update({where:{id},data:{...(d.frozenCents!==undefined?{frozenCents:d.frozenCents}:{}),...(d.creditScore!==undefined?{creditScore:d.creditScore}:{})}});
  await audit(res.locals.auth.sub,id,"CLIENT_BALANCE_CONTROL_UPDATED",{fields:Object.keys(d)});
  res.json({balance:{...safeUser(u),availableCents:Math.max(0,u.balanceCents-(u.frozenCents??0))},message:"Balance controls updated."});
}));

app.post("/api/admin/balances/:id/adjust",auth([Role.ADMIN]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const d=z.object({type:z.enum(["CREDIT","DEBIT"]),amountCents:z.coerce.number().int().positive().max(100000000),note:z.string().trim().max(300).optional()}).parse(req.body||{});
  const current=await prisma.user.findFirst({where:{id,role:Role.CLIENT,adminId:res.locals.auth.sub}});
  if(!current)return res.status(404).json({error:"Client not found in your workspace."});
  const delta=d.type==="CREDIT"?d.amountCents:-d.amountCents;
  if(delta<0&&current.balanceCents<d.amountCents)return res.status(400).json({error:"Debit amount cannot be greater than the current account balance."});
  const result=await prisma.$transaction(async tx=>{
    await tx.user.update({where:{id},data:{balanceCents:{increment:delta}}});
    const after=await tx.user.findUniqueOrThrow({where:{id}});
    if((after.frozenCents??0)>after.balanceCents)await tx.user.update({where:{id},data:{frozenCents:after.balanceCents}});
    const final=await tx.user.findUniqueOrThrow({where:{id}});
    await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:id,amountCents:delta,type:d.type==="CREDIT"?"ADMIN_CREDIT":"ADMIN_DEBIT",note:d.note||(d.type==="CREDIT"?"Balance credit by administrator":"Balance debit by administrator")}});
    return final;
  });
  await audit(res.locals.auth.sub,id,"CLIENT_BALANCE_ADJUSTED",{type:d.type,amountCents:d.amountCents});
  res.json({balance:{...safeUser(result),availableCents:Math.max(0,result.balanceCents-(result.frozenCents??0))},message:"Client balance adjustment saved."});
}));
app.patch("/api/admin/clients/:id",auth(staff),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const d=z.object({name:z.string().trim().min(2).max(80).optional(),identifier:z.string().trim().min(5).max(120).optional(),password:z.string().min(6).max(100).optional(),active:z.boolean().optional(),balanceCents:z.coerce.number().int().min(0).max(100000000).optional()}).parse(req.body);
  const current=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);
  if(!current)return res.status(404).json({error:"Client not found."});
  let identifier=current.identifier;
  if(d.identifier!==undefined){identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;if(identifier!==current.identifier){const duplicate=await prisma.user.findUnique({where:{identifier}});if(duplicate)return res.status(409).json({error:"That email or phone number is already in use."});}}
  const data:any={};
  if(d.name!==undefined)data.name=d.name;
  if(d.identifier!==undefined){data.identifier=identifier;data.identifierType=detectIdentifier(identifier);}
  if(d.password!==undefined)data.passwordHash=await hashPassword(d.password);
  if(d.active!==undefined)data.active=d.active;
  if(d.balanceCents!==undefined)data.balanceCents=d.balanceCents;
  let u=current;
  if(Object.keys(data).length){u=await prisma.user.update({where:{id},data});await audit(res.locals.auth.sub,id,"CLIENT_UPDATED",{fields:Object.keys(data)});}
  if(d.balanceCents!==undefined&&d.balanceCents!==current.balanceCents){const delta=d.balanceCents-current.balanceCents;await prisma.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:id,amountCents:delta,type:"ADMIN_ADJUSTMENT",note:"Balance updated by staff"}});}
  res.json({user:safeUser(u),message:"Client changes saved."});
}));
app.post("/api/admin/clients",auth([Role.ADMIN]),asyncRoute(async(req,res)=>{
  const d=z.object({name:z.string().trim().min(2).max(80),identifier:z.string().trim().min(5).max(120),password:z.string().min(6).max(100)}).parse(req.body);
  const identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;
  if(await prisma.user.findUnique({where:{identifier}}))return res.status(409).json({error:"That email or phone number is already in use."});
  const u=await prisma.$transaction(async tx=>{
    const c=await tx.user.create({data:{id:await uniqueUserId(),name:d.name,identifier,identifierType:detectIdentifier(identifier),passwordHash:await hashPassword(d.password),role:Role.CLIENT,adminId:res.locals.auth.sub,balanceCents:1000,welcomeBonusGrantedAt:new Date()}});
    await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:c.id,amountCents:1000,type:"WELCOME_BONUS",note:"Welcome balance"}});
    return c;
  });
  await audit(res.locals.auth.sub,u.id,"CLIENT_CREATED",{adminId:res.locals.auth.sub});
  res.status(201).json({client:safeUser(u),message:"Client created successfully."});
}));
app.get("/api/admin/clients/:id/tasks",auth(staff),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const c=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);if(!c)return res.status(404).json({error:"Client not found."});
  const session=await prisma.taskSession.findFirst({where:{clientId:id},orderBy:{createdAt:"desc"}});
  const tasks=session?await prisma.task.findMany({where:{sessionId:session.id},orderBy:{sequence:"asc"}}):[];
  res.json({tasks:tasks.map(t=>taskPublic(t,true)),client:safeUser(c),session:session?{id:session.id,vipLevel:session.vipLevel,balanceSnapshotCents:session.balanceSnapshotCents,generatedTaskCount:session.generatedTaskCount,totalTaskAmountCents:session.totalTaskAmountCents,totalExpectedCommissionCents:session.totalExpectedCommissionCents,completedTaskCount:session.completedTaskCount,resetNumber:session.resetNumber,amountOverrideCents:session.amountOverrideCents,combinationTaskCount:session.combinationTaskCount,combinationTaskAmountCents:session.combinationTaskAmountCents,combinationCommissionRateBps:session.combinationCommissionRateBps}:null});
}));
app.post("/api/admin/clients/:id/tasks",auth(staff),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const c=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);if(!c)return res.status(404).json({error:"Client not found."});
  const d=taskSchema.parse(req.body);const amount=d.amountCents??defaultTaskAmount(c.balanceCents,d.sequence);const commission=d.commissionCents??(d.commissionRateBps!==undefined?Math.round(amount*d.commissionRateBps/10000):defaultCommission(amount,Math.max(0,c.balanceCents-(c.frozenCents??0))));
  const existing=await prisma.task.findFirst({where:{clientId:id,sequence:d.sequence,sessionId:null},orderBy:{createdAt:"desc"}});
  const task=existing?await prisma.task.update({where:{id:existing.id},data:{title:d.title??existing.title,amountCents:amount,commissionCents:commission,isLucky:d.isLucky??existing.isLucky,assignedById:res.locals.auth.sub,status:TaskStatus.PENDING,revealedAt:null,completedAt:null}}):await prisma.task.create({data:{id:await uniqueTaskId(),clientId:id,assignedById:res.locals.auth.sub,sequence:d.sequence,title:d.title??(d.isLucky?"Lucky combination":"Daily task"),amountCents:amount,commissionCents:commission,isLucky:d.isLucky??false}});
  res.json({task:taskPublic(task,true),message:"Task saved for this client."});
}));
app.get("/api/admin/task-management",auth(staff),asyncRoute(async(_req,res)=>{
  const role=res.locals.auth.role;
  const clients=await prisma.user.findMany({where:staffWhere(role,res.locals.auth.sub),orderBy:{createdAt:"desc"}});
  const rows:any[]=[];
  for(const client of clients){
    const config=await getTaskManagementConfig(client.id);
    const session=await prisma.taskSession.findFirst({where:{clientId:client.id},orderBy:{createdAt:"desc"}});
    const tasks=session?await prisma.task.findMany({where:{sessionId:session.id}}):[];
    rows.push({...safeUser(client),taskManagement:{
      taskCount:session?.generatedTaskCount??config.taskCount,
      completedTasks:tasks.filter(t=>t.status===TaskStatus.COMPLETED).length,
      remainingTasks:tasks.filter(t=>t.status===TaskStatus.PENDING).length,
      resetCount:config.resetCount,
      vipLevel:session?.vipLevel??config.vipLevel,
      requiredDepositCents:config.requiredDepositCents,
      amountCents:session?.amountOverrideCents??config.amountCents,
      combinationTaskCount:session?.combinationTaskCount??config.combinationTaskCount,
      combinationTaskAmountCents:session?.combinationTaskAmountCents??config.combinationTaskAmountCents,
      combinationTaskSequences:config.combinationTaskSequences,
      combinationTaskRound:config.combinationTaskRound,
      bonus:config.bonus,
      sessionId:session?.id??null
    }});
  }
  res.json({clients:rows});
}));
app.get("/api/admin/clients/:id/task-management",auth(staff),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const client=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);if(!client)return res.status(404).json({error:"Client not found in your workspace."});
  const config=await getTaskManagementConfig(id);const session=await prisma.taskSession.findFirst({where:{clientId:id},orderBy:{createdAt:"desc"}});const tasks=session?await prisma.task.findMany({where:{sessionId:session.id}}):[];
  res.json({client:safeUser(client),taskManagement:{taskCount:config.taskCount,sessionTaskCount:session?.generatedTaskCount??null,completedTasks:tasks.filter(t=>t.status===TaskStatus.COMPLETED).length,remainingTasks:tasks.filter(t=>t.status===TaskStatus.PENDING).length,resetCount:config.resetCount,vipLevel:config.vipLevel,requiredDepositCents:config.requiredDepositCents,amountCents:config.amountCents,combinationTaskCount:config.combinationTaskCount,combinationTaskAmountCents:config.combinationTaskAmountCents,combinationCommissionRateBps:1500,combinationTaskRound:config.combinationTaskRound,bonus:config.bonus,sessionId:session?.id??null},session:session?{id:session.id,vipLevel:session.vipLevel,balanceSnapshotCents:session.balanceSnapshotCents,generatedTaskCount:session.generatedTaskCount,totalTaskAmountCents:session.totalTaskAmountCents,totalExpectedCommissionCents:session.totalExpectedCommissionCents,completedTaskCount:session.completedTaskCount,resetNumber:session.resetNumber,amountOverrideCents:session.amountOverrideCents,combinationTaskCount:session.combinationTaskCount,combinationTaskAmountCents:session.combinationTaskAmountCents,combinationCommissionRateBps:session.combinationCommissionRateBps}:null});
}));
app.patch("/api/admin/clients/:id/task-management",auth(staff),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const client=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);if(!client)return res.status(404).json({error:"Client not found in your workspace."});
  const d=z.object({requiredDepositCents:z.coerce.number().int().min(0).max(1000000000).optional(),amountCents:z.coerce.number().int().min(0).max(1000000000).optional(),vipLevel:z.string().trim().regex(/^VIP[0-9]{1,2}$/i).optional(),combinationTaskSequences:z.array(z.coerce.number().int().min(1).max(100)).optional(),combinationTaskAmountCents:z.coerce.number().int().min(0).max(1000000000).optional(),combinationTaskRound:z.coerce.number().int().min(1).max(100).optional(),bonus:z.object({content:z.string().trim().max(1000),quickActions:z.array(z.string().trim().max(120)).max(4),date:z.string().trim().max(40)}).nullable().optional()}).refine(v=>Object.values(v).some(x=>x!==undefined),{message:"Please provide a task configuration value."}).parse(req.body||{});
  const current=await getTaskManagementConfig(id);const nextVip=d.vipLevel===undefined?current.vipLevel:normalizeVipLevel(d.vipLevel);const vipRule=await getVipRule(nextVip);const taskCount=vipRule.taskCount;
  const sequences=d.combinationTaskSequences===undefined?current.combinationTaskSequences:[...new Set(d.combinationTaskSequences.map(v=>Math.trunc(v)))].sort((a,b)=>a-b);
  if(sequences.some(v=>v<1||v>taskCount))return res.status(409).json({error:"Combination task numbers must be within the client's current VIP task range.",code:"INVALID_COMBINATION_SEQUENCE"});
  const next={...current,taskCount,requiredDepositCents:d.requiredDepositCents===undefined?current.requiredDepositCents:clampMoneyCents(d.requiredDepositCents),amountCents:d.amountCents===undefined?current.amountCents:clampMoneyCents(d.amountCents),vipLevel:nextVip,combinationTaskCount:sequences.length,combinationTaskSequences:sequences,combinationTaskAmountCents:d.combinationTaskAmountCents===undefined?current.combinationTaskAmountCents:clampMoneyCents(d.combinationTaskAmountCents),combinationTaskRound:d.combinationTaskRound===undefined?current.combinationTaskRound:Math.max(1,Math.min(100,Math.trunc(d.combinationTaskRound))),bonus:d.bonus===undefined?current.bonus:d.bonus};
  await prisma.$transaction(async tx=>{await saveTaskManagementConfig(tx,id,next);},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  await audit(res.locals.auth.sub,id,"CLIENT_TASK_CONFIGURATION_UPDATED",{previous:current,next});
  res.json({client:safeUser(client),taskManagement:{...next,sessionId:null},message:"Client task configuration saved for the next Starting session."});
}));
app.post("/api/admin/clients/:id/tasks/reset",auth(staff),asyncRoute(async(req,res)=>{
  const id=param(req,"id");const client=await canManageClient(res.locals.auth.role,res.locals.auth.sub,id);if(!client)return res.status(404).json({error:"Client not found."});
  const current=await getTaskManagementConfig(id);
  const result=await prisma.$transaction(async tx=>{
  const today=new Date().toISOString().slice(0,10);
  const usageRow=await tx.setting.findUnique({where:{key:dailyResetUsageKey(id)}});
  let used=0;let usageDate=today;
  try{const parsed=usageRow?.value?JSON.parse(usageRow.value):{};usageDate=String(parsed.date||today);used=Number(parsed.count||0)}catch{}
  if(usageDate!==today)used=0;
  if(used>=3)throw Object.assign(new Error("The account can be reset at most 3 times a day."),{code:"DAILY_RESET_LIMIT"});
  const active=await tx.taskSession.findFirst({where:{clientId:id,status:"ACTIVE"},orderBy:{createdAt:"desc"}});
  if(active)await tx.taskSession.update({where:{id:active.id},data:{status:"RESET"}});
  const vipRule=await getVipRule(current.vipLevel);
  const taskCount=vipRule.taskCount;
  const combinationTaskSequences=current.combinationTaskSequences.filter(sequence=>sequence>=1&&sequence<=taskCount);
  const next={...current,taskCount,combinationTaskSequences,combinationTaskCount:combinationTaskSequences.length,resetCount:current.resetCount+1};
  await saveTaskManagementConfig(tx,id,next);
  await tx.setting.upsert({where:{key:dailyResetUsageKey(id)},create:{id:await uniqueSettingId(),key:dailyResetUsageKey(id),value:JSON.stringify({date:today,count:used+1})},update:{value:JSON.stringify({date:today,count:used+1})}});
  return next;
},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
  await audit(res.locals.auth.sub,id,"CLIENT_TASK_CYCLE_RESET",{taskCount:result.taskCount,resetCount:result.resetCount});
  res.json({tasks:[],taskManagement:{taskCount:result.taskCount,completedTasks:0,remainingTasks:result.taskCount,resetCount:result.resetCount,vipLevel:result.vipLevel,requiredDepositCents:result.requiredDepositCents,amountCents:result.amountCents,combinationTaskCount:result.combinationTaskCount,combinationTaskAmountCents:result.combinationTaskAmountCents,combinationTaskSequences:result.combinationTaskSequences},message:"Task cycle reset. The next Starting action will generate a new session. Previous history was preserved."});
}));
app.get("/api/admin/messages",auth(staff),asyncRoute(async(_req,res)=>{const role=res.locals.auth.role;const messages=await prisma.message.findMany({where:role===Role.OWNER?{}:{OR:[{senderId:res.locals.auth.sub},{recipientId:res.locals.auth.sub},{sender:{adminId:res.locals.auth.sub}},{recipient:{adminId:res.locals.auth.sub}}]},include:{sender:{select:{id:true,name:true,identifier:true,role:true,adminId:true}},recipient:{select:{id:true,name:true,role:true}}},orderBy:{createdAt:"desc"}});res.json({messages});}));
app.post("/api/admin/clients/:id/messages",auth([Role.ADMIN]),asyncRoute(async(req,res)=>{const id=param(req,"id");const d=messageSchema.omit({recipientId:true}).parse(req.body);const c=await prisma.user.findFirst({where:{id,role:Role.CLIENT,adminId:res.locals.auth.sub,active:true}});if(!c)return res.status(404).json({error:"Client not found in your workspace."});const msg=await prisma.message.create({data:{id:await uniqueMessageId(),senderId:res.locals.auth.sub,recipientId:c.id,subject:d.subject,body:d.body}});res.status(201).json({message:msg});}));
app.patch("/api/admin/messages/:id",auth(staff),asyncRoute(async(req,res)=>{const id=param(req,"id");const d=z.object({status:z.enum(["OPEN","REPLIED","CLOSED"]),reply:z.string().max(3000).optional()}).parse(req.body);const current=await prisma.message.findUniqueOrThrow({where:{id},include:{sender:{select:{id:true,role:true,adminId:true}}}});if(res.locals.auth.role===Role.ADMIN&&current.sender.role===Role.CLIENT&&current.sender.adminId!==res.locals.auth.sub)return res.status(403).json({error:"This conversation is outside your workspace."});let reply=null;if(d.reply?.trim())reply=await prisma.message.create({data:{id:await uniqueMessageId(),senderId:res.locals.auth.sub,recipientId:current.senderId,subject:`Re: ${current.subject}`,body:d.reply.trim(),status:MessageStatus.REPLIED}});const message=await prisma.message.update({where:{id},data:{status:d.status}});res.json({message,reply});}));

app.get("/api/owner/admins",auth([Role.OWNER]),asyncRoute(async(_req,res)=>{
  const admins=await prisma.user.findMany({where:{role:Role.ADMIN},orderBy:{createdAt:"desc"}});
  const rows=await Promise.all(admins.map(async a=>{
    const setting=await prisma.setting.findUnique({where:{key:`telegram_admin_${a.id}`}});
    return {...safeUser(a),inviteCode:a.inviteCode,telegramUsername:setting?.value||""};
  }));
  res.json({admins:rows});
}));
app.post("/api/owner/admins",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const d=z.object({name:z.string().trim().min(2).max(80),identifier:z.string().trim().min(5).max(120),password:z.string().min(6).max(100)}).parse(req.body);const identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;if(await prisma.user.findUnique({where:{identifier}}))return res.status(409).json({error:"That email or phone number is already in use."});const inviteCode=await uniqueInviteCode();const admin=await prisma.user.create({data:{id:await uniqueUserId(),name:d.name,identifier,identifierType:detectIdentifier(identifier),passwordHash:await hashPassword(d.password),role:Role.ADMIN,inviteCode}});await audit(res.locals.auth.sub,admin.id,"ADMIN_CREATED",{inviteCode});res.status(201).json({admin:{...safeUser(admin),inviteCode},message:"Admin created successfully."});}));
app.patch("/api/owner/admins/:id",auth([Role.OWNER]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const d=z.object({name:z.string().trim().min(2).max(80).optional(),identifier:z.string().trim().min(5).max(120).optional(),password:z.string().min(6).max(100).optional(),active:z.boolean().optional(),telegramUsername:z.string().trim().max(120).optional()}).parse(req.body);
  const admin=await prisma.user.findFirst({where:{id,role:Role.ADMIN}});
  if(!admin)return res.status(404).json({error:"Admin not found."});
  let identifier=admin.identifier;
  if(d.identifier!==undefined){identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;if(identifier!==admin.identifier){const duplicate=await prisma.user.findUnique({where:{identifier}});if(duplicate)return res.status(409).json({error:"That email or phone number is already in use."});}}
  const data:any={};
  if(d.name!==undefined)data.name=d.name;
  if(d.identifier!==undefined){data.identifier=identifier;data.identifierType=detectIdentifier(identifier);}
  if(d.password!==undefined)data.passwordHash=await hashPassword(d.password);
  if(d.active!==undefined)data.active=d.active;
  const u=await prisma.user.update({where:{id},data});
  if(d.telegramUsername!==undefined){const key=`telegram_admin_${id}`;if(d.telegramUsername.trim())await prisma.setting.upsert({where:{key},create:{id:await uniqueSettingId(),key,value:d.telegramUsername.trim().replace(/^@/,"")},update:{value:d.telegramUsername.trim().replace(/^@/,"")}});else await prisma.setting.deleteMany({where:{key}});}
  const telegramSetting=await prisma.setting.findUnique({where:{key:`telegram_admin_${id}`}});
  await audit(res.locals.auth.sub,id,"ADMIN_UPDATED",{fields:[...Object.keys(data),...(d.telegramUsername!==undefined?["telegramUsername"]:[])]});
  res.json({admin:{...safeUser(u),inviteCode:u.inviteCode,telegramUsername:telegramSetting?.value||""},message:"Admin changes saved."});
}));
app.delete("/api/owner/admins/:id",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const id=param(req,"id");const admin=await prisma.user.findFirst({where:{id,role:Role.ADMIN}});if(!admin)return res.status(404).json({error:"Admin not found."});await audit(res.locals.auth.sub,id,"ADMIN_DELETED");await prisma.user.delete({where:{id}});res.json({message:"Admin removed."});}));
app.post("/api/owner/clients",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const d=z.object({name:z.string().trim().min(2).max(80),identifier:z.string().trim().min(5).max(120),password:z.string().min(6).max(100),adminId:z.string().regex(/^\d{5}$/)}).parse(req.body);const identifier=d.identifier.includes("@")?d.identifier.toLowerCase():d.identifier;const admin=await prisma.user.findFirst({where:{id:d.adminId,role:Role.ADMIN,active:true}});if(!admin)return res.status(400).json({error:"Choose an active administrator."});if(await prisma.user.findUnique({where:{identifier}}))return res.status(409).json({error:"That email or phone number is already in use."});const u=await prisma.$transaction(async tx=>{const c=await tx.user.create({data:{id:await uniqueUserId(),name:d.name,identifier,identifierType:detectIdentifier(identifier),passwordHash:await hashPassword(d.password),role:Role.CLIENT,adminId:admin.id,balanceCents:1000,welcomeBonusGrantedAt:new Date()}});await tx.walletTransaction.create({data:{id:await uniqueWalletTransactionId(),userId:c.id,amountCents:1000,type:"WELCOME_BONUS",note:"Welcome balance"}});return c;});res.status(201).json({client:safeUser(u),message:"Client created successfully."});}));
app.delete("/api/owner/clients/:id",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const id=param(req,"id");const c=await prisma.user.findFirst({where:{id,role:Role.CLIENT}});if(!c)return res.status(404).json({error:"Client not found."});await audit(res.locals.auth.sub,id,"CLIENT_DELETED");await prisma.user.delete({where:{id}});res.json({message:"Client removed."});}));
app.get("/api/owner/users/:id",auth([Role.OWNER]),asyncRoute(async(req,res)=>{
  const id=param(req,"id");
  const user=await prisma.user.findUnique({where:{id},include:{admin:{select:{id:true,name:true,identifier:true,active:true}},managedClients:{select:{id:true,name:true,identifier:true,active:true}},walletTransactions:{orderBy:{createdAt:"desc"},take:30},tasks:{orderBy:{sequence:"asc"}},messagesSent:{orderBy:{createdAt:"desc"},take:20},messagesOwned:{orderBy:{createdAt:"desc"},take:20}}});
  if(!user||user.role===Role.OWNER)return res.status(404).json({error:"Account not found."});
  const auditLogs=await prisma.auditLog.findMany({where:{OR:[{targetId:id},{actorId:id}]},orderBy:{createdAt:"desc"},take:50});
  const telegramSetting=user.role===Role.ADMIN?await prisma.setting.findUnique({where:{key:`telegram_admin_${id}`} }):null;
  res.json({user:{...safeUser(user),inviteCode:user.role===Role.ADMIN?user.inviteCode:null,telegramUsername:telegramSetting?.value||""},admin:user.admin?{id:user.admin.id,name:user.admin.name,identifier:user.admin.identifier,active:user.admin.active}:null,clients:user.managedClients.map(safeUser),transactions:user.walletTransactions,tasks:user.tasks.map(t=>taskPublic(t,true)),messages:[...user.messagesSent,...user.messagesOwned],auditLogs});
}));
app.get("/api/owner/audit",auth([Role.OWNER]),asyncRoute(async(req,res)=>{
  const take=Math.min(Number(req.query.take||100),250);
  const logs=await prisma.auditLog.findMany({take,orderBy:{createdAt:"desc"},include:{actor:{select:{id:true,name:true,role:true}},target:{select:{id:true,name:true,role:true}}}});
  res.json({logs});
}));
app.get("/api/owner/settings",auth([Role.OWNER]),asyncRoute(async(_req,res)=>res.json({settings:await prisma.setting.findMany({orderBy:{key:"asc"}})})));
app.patch("/api/owner/settings/:key",auth([Role.OWNER]),asyncRoute(async(req,res)=>{const key=param(req,"key");const d=z.object({value:z.string().max(1000)}).parse(req.body);const setting=await prisma.setting.upsert({where:{key},create:{id:await uniqueSettingId(),key,value:d.value},update:{value:d.value}});res.json({setting});}));

app.use((req,res)=>res.status(404).json({error:"Route not found.",path:req.path}));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(err instanceof z.ZodError)return res.status(422).json({error:err.issues[0]?.message||"Please check the submitted details.",code:"VALIDATION_ERROR"});
  if(err instanceof Error&&err.message==="Origin is not allowed by CORS.")return res.status(403).json({error:"This origin is not allowed to access the API.",code:"CORS_FORBIDDEN"});
  if(err instanceof Error&&(err as any).code==="DAILY_RESET_LIMIT")return res.status(429).json({error:err.message,code:"DAILY_RESET_LIMIT"});
  console.error(err);
  if(isProduction)return res.status(500).json({error:"An unexpected server error occurred.",code:"INTERNAL_ERROR"});
  return res.status(500).json({error:err instanceof Error?err.message:"Something went wrong. Please try again.",code:"INTERNAL_ERROR"});
});

const server=app.listen(port,"0.0.0.0",()=>{console.log(`Box Office Mojo API listening on ${port}`);void runMigrationsUntilReady();});
server.on("error",e=>{console.error(e);process.exitCode=1;});
void upsertDefaultTaskPriceSettings().catch(error=>console.error("[pricing-config]",error));

function runMigrations(){return new Promise<void>((resolve,reject)=>{const args=["prisma","migrate","deploy","--schema=prisma/schema.prisma"];migrationProcess=execFile(process.platform==="win32"?(process.env.ComSpec||"cmd.exe"):"npx",process.platform==="win32"?["/d","/s","/c","npx "+args.join(" ")]:args,{cwd:process.cwd(),env:process.env,windowsHide:true},(error,stdout,stderr)=>{migrationProcess=null;if(stdout.trim())console.log(stdout.trim());if(stderr.trim())console.error(stderr.trim());error?reject(error):resolve();});});}
async function runMigrationsUntilReady(){let delay=2000;while(!applicationReady){try{await runMigrations();await prisma.$queryRaw`SELECT 1`;await ensureOwnerFromEnv();await upsertDefaultTaskPriceSettings();await upsertDefaultVipRules();applicationReady=true;console.log("Database ready.");}catch(e){console.error(`Database/migration startup failed; retrying in ${Math.ceil(delay/1000)}s`,e);await new Promise(r=>setTimeout(r,delay));delay=Math.min(delay*2,30000);}}}
async function shutdown(signal:string){console.log(`${signal} received.`);if(migrationProcess) migrationProcess.kill();await prisma.$disconnect();server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10000);}
process.on("SIGINT",()=>void shutdown("SIGINT"));process.on("SIGTERM",()=>void shutdown("SIGTERM"));
