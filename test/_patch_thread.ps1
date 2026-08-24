$f = "D:\bakcup\Desktop\科研agent\app\server\engine\orchestrator.js"
$c = [System.IO.File]::ReadAllText($f)
# 两处 thread_id 都用 _turnSeq
$c = $c.Replace('thread_id: conv.id }, recursionLimit: 60 }', 'thread_id: conv.id + "#t" + conv._turnSeq }, recursionLimit: 60 }')
# resumeApproval: 在 conv._turnSpoken 旧写法前补 _turnSeq 递增
$oldRa = "conv._turnSpoken = conv._turnSpoken || new Set();`n        const threadConfig = { configurable: { thread_id: conv.id + `"#t`" + conv._turnSeq }, recursionLimit: 60 };"
$newRa = "conv._turnSpoken = new Set();`n        conv._turnSeq = (conv._turnSeq || 0) + 1;`n        const threadConfig = { configurable: { thread_id: conv.id + `"#t`" + conv._turnSeq }, recursionLimit: 60 };"
$c = $c.Replace($oldRa, $newRa)
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($f, $c, $utf8)
Write-Output "patched"
Select-String -Path $f -Pattern "thread_id:|_turnSeq" | Select-Object LineNumber,Line
