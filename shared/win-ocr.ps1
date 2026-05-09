param(
    [string[]]$imagePaths,
    [string]$listFile
)

if ($listFile -and (Test-Path $listFile)) {
    $imagePaths = Get-Content $listFile -Encoding UTF8
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrResult, Windows.Media, ContentType=WindowsRuntime]

$script:asTaskGeneric = (
    [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.IsGenericMethodDefinition -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        } |
        Select-Object -First 1
)

function Await-WinRt($operation, [Type]$resultType) {
    if ($null -eq $operation) {
        throw "WinRT async operation is null"
    }
    if ($null -eq $script:asTaskGeneric) {
        throw "System.WindowsRuntimeSystemExtensions.AsTask was not found"
    }

    $task = $script:asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait()
    return $task.Result
}

function Write-OcrResult([string]$path, [string]$text) {
    Write-Output "---START---"
    Write-Output "PATH:$path"
    Write-Output "TEXT:$text"
    Write-Output "---END---"
}

function Write-OcrError([string]$path, [string]$message) {
    Write-Output "---START---"
    Write-Output "PATH:$path"
    Write-Output "ERROR:$message"
    Write-Output "---END---"
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
    Write-Error "Windows OCR engine is not available for the current user profile languages."
    exit 1
}

foreach ($imgPath in $imagePaths) {
    $stream = $null
    $bitmap = $null

    try {
        if (-not (Test-Path -LiteralPath $imgPath)) {
            Write-OcrError $imgPath "File not found"
            continue
        }

        $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgPath)) ([Windows.Storage.StorageFile])
        $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

        Write-OcrResult $imgPath $result.Text
    } catch {
        Write-OcrError $imgPath $_.Exception.Message
    } finally {
        if ($null -ne $stream) {
            try { $stream.Dispose() } catch {}
        }
        if ($null -ne $bitmap) {
            try { $bitmap.Dispose() } catch {}
        }
    }
}
