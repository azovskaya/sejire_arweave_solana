import {pbkdf2Sync} from 'node:crypto';

export const adminPassword='Synthetic admin password for tests 2026!';
const salt=Buffer.alloc(32,7);
export const adminLock={schema:'sejire/admin-lock/v1',algorithm:'PBKDF2-SHA256',configured:true,iterations:600000,
  salt:salt.toString('base64'),digest:pbkdf2Sync(adminPassword,salt,600000,32,'sha256').toString('base64')};

export async function mockAdminLock(page){
  await page.route('**/admin-lock.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(adminLock)}));
}
