local money=dofile('ao/modules/lamports.lua')
assert(money.add('30000000','5000000')=='35000000')
assert(money.add('18446744073709551615','18446744073709551615')=='36893488147419103230')
assert(money.u64('18446744073709551615')=='18446744073709551615')
assert(not pcall(money.u64,'18446744073709551616'))
assert(not pcall(money.check,'1e9'))
local gate=dofile('ao/modules/journal_gate.lua')
assert(not pcall(gate.instantiate,{},{}))
local calls=0
local handler=gate.instantiate({verifyCreation=function()return true end,applySigned=function()calls=calls+1 end,snapshot=function()return {} end},{})
for _,action in ipairs({'Eval','Owner','AddOwner','RemoveOwner','SetAuthorities'})do
 assert(not pcall(handler,{message={domain='sejire/protocol-journal/v1',action=action}}))
end
assert(calls==0)
print('PASS Lua exact lamports and fail-closed module boundary (LOCAL gate stub only; NOT live AO threshold/Eval proof)')
