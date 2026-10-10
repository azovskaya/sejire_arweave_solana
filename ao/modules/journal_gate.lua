-- IMMUTABLE MODULE BOUNDARY, NOT an aos .load/Eval script and NOT a deployed process.
-- Runtime cryptography/canonical kernel must be pinned in the process module.
-- It is deliberately fail-closed until a verified AO runtime binding exists.
local allowed={Order=true,Pending=true,Payment=true,UploadPlan=true,UploadResult=true,Policy=true}
local M={}
function M.instantiate(runtime,creation)
  assert(type(runtime)=='table' and type(runtime.verifyCreation)=='function'
    and type(runtime.applySigned)=='function' and type(runtime.snapshot)=='function','verified_runtime_required')
  -- Creation from the authenticated spawn/module binding, not the first caller.
  assert(runtime.verifyCreation(creation),'untrusted_process_creation')
  local apply,snapshot=runtime.applySigned,runtime.snapshot
  return function(event)
    assert(type(event)=='table' and type(event.message)=='table','signed_message_required')
    local message=event.message
    assert(message.domain=='sejire/protocol-journal/v1' and allowed[message.action],'action_not_permitted')
    assert(message.Owner==nil and message.Authorities==nil and message.Eval==nil,'runtime_override_forbidden')
    -- From/verified=true in payload cannot authorize anything: the pinned runtime
    -- verifies canonical signatures and management threshold inside applySigned.
    apply(event)
    return snapshot()
  end
end
return M
