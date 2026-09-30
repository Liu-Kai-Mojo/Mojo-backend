import { PrismaClient } from "@prisma/client";
const prisma=new PrismaClient();
(async()=>{
  try{
    const rows=await prisma.$queryRawUnsafe<Array<{migration_name:string;started_at:string|null;finished_at:string|null;rolled_back_at:string|null;logs:string|null}>>(
      'SELECT migration_name, started_at, finished_at, rolled_back_at, logs FROM "_prisma_migrations" WHERE migration_name = $1',
      "20260930200000_task_escrow_rounds"
    );
    console.log(JSON.stringify(rows,null,2));
  }catch(error){console.error(error);process.exitCode=1}finally{await prisma.$disconnect()}
})();