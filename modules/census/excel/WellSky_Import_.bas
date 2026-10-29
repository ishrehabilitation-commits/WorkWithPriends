Attribute VB_Name = "WellSky_Import_"
Option Explicit
'**************************************************************************
' WellSky -> Therapy Schedule
' Fills the 1st Med, 2nd Med and AMU-Psych tgt from the WellSky Rehab
' Census tab in WorkWithPriends ("Copy for Schedule" button, or the file).
'
' Only these columns are written:  A  C  F  G  H  I  J  K  M  N  P
' Cell formatting is never changed. Rooms are matched on column B.
' At the end, rows whose room has nobody on the WellSky census (discharged,
' or added by mistake) are cleared in A and C:P. Column B and formulas stay.
'**************************************************************************

Private Const TAG As String = "#WELLSKY-SCHEDULE"
Private Const MAX_ROW As Long = 200

Public Sub UpdateFromWellSky()
    Dim txt As String, lines() As String, hdr() As String, f() As String
    Dim data As Object, rec As Object, seen As Object
    Dim i As Long, j As Long, r As Long, s As Long
    Dim tgt As Variant, ws As Worksheet
    Dim fn As Variant, msg As String, errMsg As String
    Dim wasProtected(0 To 2) As Boolean
    Dim key As String, curName As String
    Dim noRoom As String, notOnSheet As String, changedList As String, vacatedList As String
    Dim toReplace As Collection, toVacate As Collection, item As Variant
    Dim updated As Long, cleared As Long, filled As Long

    '--- 1. Get the export (clipboard first, then ask for the file) ---
    txt = ClipboardText()
    If Left$(txt, Len(TAG)) <> TAG Then
        fn = Application.GetOpenFilename("WellSky schedule export (*.txt;*.tsv),*.txt;*.tsv", , _
             "Pick the schedule file from the WorkWithPriends Census tab")
        If VarType(fn) = vbBoolean Then Exit Sub
        txt = ReadUtf8(CStr(fn))
        If Left$(txt, Len(TAG)) <> TAG Then
            MsgBox "That doesn't look like a WellSky schedule export." & vbLf & _
                   "In the WorkWithPriends Census tab click 'Copy for Schedule' and run this again.", vbExclamation
            Exit Sub
        End If
    End If

    '--- 2. Parse it: one record per room ---
    txt = Replace(txt, vbCrLf, vbLf)
    lines = Split(txt, vbLf)
    If UBound(lines) < 1 Then Exit Sub
    hdr = Split(lines(1), vbTab)
    Set data = CreateObject("Scripting.Dictionary")
    Set seen = CreateObject("Scripting.Dictionary")
    For i = 2 To UBound(lines)
        If Len(Trim$(lines(i))) > 0 Then
            f = Split(lines(i), vbTab)
            Set rec = CreateObject("Scripting.Dictionary")
            For j = 0 To UBound(hdr)
                If j <= UBound(f) Then rec(hdr(j)) = Unescape(f(j)) Else rec(hdr(j)) = ""
            Next j
            If rec("room") = "" Then
                noRoom = noRoom & vbLf & "   " & rec("A")
            Else
                Set data(UCase$(rec("room"))) = rec
            End If
        End If
    Next i

    tgt = Array(shPatientRooms, sh2ndMed, shAMUPsych)

    '--- 3. First pass: rooms with a different patient now, and rooms nobody is in any more ---
    Set toReplace = New Collection
    Set toVacate = New Collection
    For s = 0 To UBound(tgt)
        Set ws = tgt(s)
        For r = 3 To MAX_ROW
            If UCase$(Trim$(ws.Cells(r, "B").Value & "")) = "RM#" Then Exit For
            key = RoomKey(ws.Cells(r, "B").Value & "")
            curName = Trim$(ws.Cells(r, "A").Value & "")
            If key <> "" Then
                If curName <> "" Then filled = filled + 1
                If data.Exists(key) Then
                    seen(key) = True
                    If curName <> "" And NameKey(curName) <> NameKey(data(key)("A")) Then
                        changedList = changedList & vbLf & "   " & key & ":  " & OneLine(curName) & "  ->  " & data(key)("A")
                        toReplace.Add Array(s, r)
                    End If
                ElseIf RowHasText(ws, r) Then
                    vacatedList = vacatedList & vbLf & "   " & key & ":  " & IIf(curName = "", "(no name)", OneLine(curName))
                    toVacate.Add Array(s, r)
                End If
            End If
        Next r
    Next s

    ' Guard against the wrong facility's export wiping the sheets.
    If data.Count > 0 And seen.Count = 0 Then
        MsgBox "None of the rooms in this WellSky export are on the schedule sheets, so nothing was changed." & vbLf & _
               "Check the facility picked in the WorkWithPriends header and copy again.", vbExclamation, "WellSky update"
        Exit Sub
    End If
    If toVacate.Count > 5 And toVacate.Count * 2 > filled Then
        If MsgBox("WellSky has nobody in " & toVacate.Count & " of the " & filled & " filled rooms:" & vacatedList & vbLf & vbLf & _
                  "Clear them all?  (No = update everything else and leave these rows.)", _
                  vbYesNo + vbExclamation, "WellSky update") = vbNo Then
            Set toVacate = New Collection
            vacatedList = ""
        End If
    End If

    '--- 4. Write ---
    Application.ScreenUpdating = False
    Application.EnableEvents = False
    On Error GoTo CleanUp

    For s = 0 To UBound(tgt)
        Set ws = tgt(s)
        wasProtected(s) = ws.ProtectContents
        If wasProtected(s) Then ws.Unprotect
    Next s

    ' New patient in the room: clear the old one first so nothing carries over.
    For Each item In toReplace
        Set ws = tgt(item(0))
        ClearPatientRow ws, CLng(item(1))
    Next item

    For s = 0 To UBound(tgt)
        Set ws = tgt(s)
        For r = 3 To MAX_ROW
            If UCase$(Trim$(ws.Cells(r, "B").Value & "")) = "RM#" Then Exit For
            key = RoomKey(ws.Cells(r, "B").Value & "")
            If key <> "" And data.Exists(key) Then
                Set rec = data(key)
                ApplyValue ws.Cells(r, "A"), rec("A")
                ApplyValue ws.Cells(r, "C"), rec("C")
                ApplyValue ws.Cells(r, "F"), rec("F")
                ApplyValue ws.Cells(r, "G"), rec("G")
                ApplyValue ws.Cells(r, "H"), rec("H")
                ApplyValue ws.Cells(r, "I"), rec("I")
                ApplyValue ws.Cells(r, "J"), rec("J")
                ApplyValue ws.Cells(r, "K"), rec("K")
                ApplyValue ws.Cells(r, "M"), rec("M")
                ApplyValue ws.Cells(r, "N"), rec("N")
                ApplyValue ws.Cells(r, "P"), rec("P")
                updated = updated + 1
            End If
        Next r
    Next s

    '--- 5. Cleanup: discharged (or wrongly added) patients ---
    For Each item In toVacate
        Set ws = tgt(item(0))
        ClearPatientRow ws, CLng(item(1))
        cleared = cleared + 1
    Next item

    For Each item In data.Keys
        If Not seen.Exists(item) Then notOnSheet = notOnSheet & vbLf & "   " & item & ":  " & data(item)("A")
    Next item

CleanUp:
    If Err.Number <> 0 Then errMsg = "Stopped on an error: " & Err.Description & vbLf & vbLf
    On Error Resume Next
    For s = 0 To UBound(tgt)
        If wasProtected(s) Then tgt(s).Protect
    Next s
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    On Error GoTo 0

    msg = errMsg & "Updated " & updated & " patient row(s)."
    If changedList <> "" Then msg = msg & vbLf & vbLf & "New patient in these rooms:" & changedList
    If cleared > 0 Then msg = msg & vbLf & vbLf & "Cleared (not on the WellSky census):" & vacatedList
    If notOnSheet <> "" Then msg = msg & vbLf & vbLf & "Room not found on the schedule:" & notOnSheet
    If noRoom <> "" Then msg = msg & vbLf & vbLf & "No room assigned in WellSky:" & noRoom
    MsgBox msg, IIf(errMsg = "", vbInformation, vbExclamation), "WellSky update"
End Sub

'--- write one cell according to the export's conventions ---
'   ""            leave the cell alone
'   {CLEAR}       clear it
'   {IFBLANK}x    write x only if the cell is empty
'   {LINE1}x      replace the first line, keep any later lines (Admit / D/C)
Private Sub ApplyValue(c As Range, ByVal v As String)
    Dim cur As String, p As Long
    If v = "" Then Exit Sub
    If v = "{CLEAR}" Then
        c.ClearContents
    ElseIf Left$(v, 9) = "{IFBLANK}" Then
        If Len(Trim$(c.Value & "")) = 0 Then WriteText c, Mid$(v, 10)
    ElseIf Left$(v, 7) = "{LINE1}" Then
        cur = c.Value & ""
        p = InStr(cur, vbLf)
        If p > 0 Then WriteText c, Mid$(v, 8) & Mid$(cur, p) Else WriteText c, Mid$(v, 8) & vbLf
    Else
        WriteText c, v
    End If
End Sub

' Clears A and C:P on one row (column B and any formulas stay).
Private Sub ClearPatientRow(ws As Worksheet, ByVal r As Long)
    Dim c As Range
    For Each c In Union(ws.Cells(r, "A"), ws.Range(ws.Cells(r, "C"), ws.Cells(r, "P"))).Cells
        If c.MergeCells Then
            If c.Address = c.MergeArea.Cells(1, 1).Address And Not c.HasFormula Then c.MergeArea.ClearContents
        ElseIf Not c.HasFormula Then
            c.ClearContents
        End If
    Next c
End Sub

' True if A or C:P has any typed-in text (formulas don't count).
Private Function RowHasText(ws As Worksheet, ByVal r As Long) As Boolean
    Dim c As Range
    For Each c In Union(ws.Cells(r, "A"), ws.Range(ws.Cells(r, "C"), ws.Cells(r, "P"))).Cells
        If Not c.HasFormula And Len(Trim$(c.Value & "")) > 0 Then RowHasText = True: Exit Function
    Next c
End Function

' Team stays a number; anything Excel would turn into a date/number stays text.
Private Sub WriteText(c As Range, ByVal v As String)
    If c.Column = 13 And IsNumeric(v) Then
        c.Value = CLng(v)
    ElseIf (IsDate(v) Or IsNumeric(v)) And c.NumberFormat <> "@" Then
        c.Value = "'" & v
    Else
        c.Value = v
    End If
End Sub

Private Function RoomKey(ByVal b As String) As String
    Dim p As Long
    b = Replace(b, vbCr, "")
    p = InStr(b, vbLf)
    If p > 0 Then b = Left$(b, p - 1)
    RoomKey = UCase$(Trim$(b))
End Function

' "Smith, John A (64M)" / "SMITH, JOHN" / "Smith, John "Jack"(64M)"  ->  "SMITH|JOHN"
Private Function NameKey(ByVal n As String) As String
    Dim p As Long, last As String, first As String
    p = InStr(n, "(")
    If p > 0 Then n = Left$(n, p - 1)
    n = UCase$(Trim$(Replace(Replace(n, """", " "), vbLf, " ")))
    p = InStr(n, ",")
    If p = 0 Then NameKey = n: Exit Function
    last = Trim$(Left$(n, p - 1))
    first = Trim$(Mid$(n, p + 1))
    p = InStr(first, " ")
    If p > 0 Then first = Left$(first, p - 1)
    NameKey = last & "|" & first
End Function

Private Function OneLine(ByVal s As String) As String
    OneLine = Replace(Replace(s, vbCr, ""), vbLf, " ")
End Function

Private Function Unescape(ByVal s As String) As String
    s = Replace(s, "\\", Chr$(1))
    s = Replace(s, "\n", vbLf)
    Unescape = Replace(s, Chr$(1), "\")
End Function

Private Function ClipboardText() As String
    On Error Resume Next
    With CreateObject("New:{1C3B4210-F441-11CE-B9EA-00AA006B1A69}")
        .GetFromClipboard
        ClipboardText = .GetText(1)
    End With
End Function

Private Function ReadUtf8(ByVal path As String) As String
    With CreateObject("ADODB.Stream")
        .Type = 2
        .Charset = "utf-8"
        .Open
        .LoadFromFile path
        ReadUtf8 = .ReadText
        .Close
    End With
    If Left$(ReadUtf8, 1) = ChrW$(&HFEFF) Then ReadUtf8 = Mid$(ReadUtf8, 2)
End Function
