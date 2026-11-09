param()
$d='C:\Users\NANO TECHNOLOGY\Desktop\Bio Guard Website Demo'
$t=[IO.File]::ReadAllText("$d\src\template.html",[Text.Encoding]::UTF8)
$old=[IO.File]::ReadAllText("$d\v2-kit-version\index.html",[Text.Encoding]::UTF8)
$m=[regex]::Match($old,'var CKB=\{(.*?)\n\};',[Text.RegularExpressions.RegexOptions]::Singleline)
$t=$t.Replace('@@CKB@@',($m.Groups[1].Value.TrimEnd().TrimEnd(',')+','))
$t=$t.Replace('//@@ATLAS@@',[IO.File]::ReadAllText("$d\src\atlas.js",[Text.Encoding]::UTF8))
$srv=$t.Replace('<!--ADMIN-->',' &middot; <a href="admin" style="color:inherit">Admin</a>')
# the server version uses its own copy of three.js (vendor folder); the single-file version keeps the public CDN
$srv=$srv.Replace('https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js','/vendor/three.module.js').Replace('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/','/vendor/addons/')
$sa=$t.Replace('<!--ADMIN-->','')
foreach($f in Get-ChildItem "$d\Bio Guard Demo\img" -File){
 $mime=switch($f.Extension){'.png'{'image/png'}'.webp'{'image/webp'}default{'image/jpeg'}}
 $srv=$srv.Replace('@@'+$f.Name+'@@','img/'+$f.Name)
 $sa=$sa.Replace('@@'+$f.Name+'@@',"data:$mime;base64,"+[Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName)))
}
$u=New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText("$d\Bio Guard.html",$sa,$u); [IO.File]::WriteAllText("$d\index.html",$sa,$u)
[IO.File]::WriteAllText("$d\Bio Guard Demo\index.html",$srv,$u)
[IO.File]::WriteAllText("$d\Bio Guard Demo\admin.html",[IO.File]::ReadAllText("$d\src\admin.html",[Text.Encoding]::UTF8),$u)