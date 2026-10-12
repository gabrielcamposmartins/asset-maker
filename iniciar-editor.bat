@echo off
rem Abre o editor Asset Maker em http://localhost:8741 (com os botoes de ligar/desligar o servidor local).
cd /d "%~dp0"

rem Atencao: "where python" acha o atalho da Microsoft Store mesmo sem Python instalado,
rem e esse atalho so imprime "Python nao foi encontrado". Por isso testamos rodando de verdade.
python -c "" >nul 2>nul && goto :com_python
py -3 -c "" >nul 2>nul && goto :com_py

echo.
echo Nenhum Python utilizavel foi encontrado no PATH.
echo.
echo Opcoes:
echo   1) Instale o Python em https://www.python.org/downloads/ marcando "Add python.exe to PATH".
echo   2) Se ja tiver Python instalado, desligue os atalhos da Microsoft Store em
echo      Configuracoes ^> Aplicativos ^> Configuracoes avancadas do aplicativo ^>
echo      Aliases de execucao do aplicativo (desmarque python.exe e python3.exe).
echo.
pause
exit /b 1

:com_python
python serve.py --open
if errorlevel 1 pause
exit /b

:com_py
py serve.py --open
if errorlevel 1 pause
exit /b
