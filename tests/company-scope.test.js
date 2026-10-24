const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const jwt=require('jsonwebtoken');
const mongoose=require('mongoose');
const M=require('../src/models');
const {withCompany}=require('../src/services/companyContext');
const key=crypto.randomBytes(48).toString('hex');process.env.JWT_SECRET=key;
test('authenticated APIs enforce company isolation for ordinary data, analytics and settings',async t=>{
 const dbName=`hcm_test_scope_${process.pid}_${Date.now()}`;
 await mongoose.connect(process.env.TEST_MONGODB_URI||'mongodb://127.0.0.1:27017/?replicaSet=hcm',{dbName});
 await Promise.all(Object.values(M).map(m=>m.init()));
 const ca=await M.Company.create({singleton:'a',name:'Company A',weekend:[]});const cb=await M.Company.create({singleton:'b',name:'Company B',weekend:[]});
 async function fixture(company,suffix){return withCompany(company._id,async()=>{
  const dept=await M.Department.create({name:"Shared department name"});const role=await M.Designation.create({name:"Shared role name"});
  const admin=await M.User.create({name:`Admin ${suffix}`,email:`admin-${suffix}@example.test`,role:'admin',passwordHash:'unused-isolated-test-hash',mustChangePassword:false});
  const user=await M.User.create({name:`Employee ${suffix}`,email:`employee-${suffix}@example.test`,role:'employee',passwordHash:'unused-isolated-test-hash',mustChangePassword:false});
  const emp=await M.Employee.create({user:user._id,name:user.name,email:user.email,code:"SAME-CODE",department:dept._id,designation:role._id,joinDate:'2026-01-01',basic:1000});
  user.employee=emp._id;await user.save();await M.Announcement.create({title:`Private ${suffix}`,body:`Only ${suffix}`,actor:admin._id});return {admin,user,emp,dept};
 });}
 const a=await fixture(ca,'a'),b=await fixture(cb,'b');
 const server=require('../src/app').listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await mongoose.connection.dropDatabase();await mongoose.disconnect();});
 async function request(user,path,method='GET',body,company=user.company){const token=jwt.sign({sub:String(user._id),version:user.tokenVersion,company:String(company)},key,{algorithm:'HS256',expiresIn:'5m'});const response=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
 const directory=await request(a.admin,'/employees');assert.equal(directory.status,200);assert.equal(directory.data.total,1);assert.equal(directory.data.items[0]._id,String(a.emp._id));
 assert.equal((await request(a.admin,`/employees/${b.emp._id}`)).status,404);
 const announcements=await request(a.user,'/announcements');assert.equal(announcements.data.length,1);assert.equal(announcements.data[0].title,'Private a');
 const settings=await request(a.admin,'/company');assert.equal(settings.data._id,String(ca._id));
 assert.equal((await request(a.user,'/auth/me','GET',null,cb._id)).status,401);
 const analytics=await request(a.admin,'/attendance/analytics?start=2026-10-01&end=2026-10-02');assert.equal(analytics.status,200);assert.equal(analytics.data.summary.totalEmployees,1);
 const other=await request(a.user,`/attendance/analytics?employee=${b.emp._id}`);assert.ok([403,404].includes(other.status));
 const own=await request(a.user,'/employees');assert.equal(own.data.total,1);assert.equal(own.data.items[0]._id,String(a.emp._id));
 assert.equal((await request(a.user,'/attendance/check-in','POST',{verified:true})).status,422);
});
