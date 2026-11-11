# Estación IoT para monitoreo ambiental e incendios

Proyecto semestral de Herramientas de Programación Aplicada IV. El ESP32 simulado mide gas, temperatura y humedad, publica las lecturas por MQTT y activa una alarma local. El receptor Python valida las lecturas, las guarda en CSV y registra los cambios de comunicación.

- [Guía para ejecutar el ESP32 y el receptor desde Visual Studio 2026](Avance3_IoT_Silencio/README.md)
- [Simulación del avance 3 en Wokwi](https://wokwi.com/projects/480352064884833281)
- [Informe y matriz de pruebas](dist/evidencia/informe.pdf)

## Abrir el dashboard

En una segunda terminal de PowerShell abierta en la raíz del repositorio, ejecuta los siguientes comandos después de preparar el entorno Python.

```powershell
Set-Location .\Avance3_IoT_Silencio
.\.venv\Scripts\python.exe -m http.server 8000 --bind 127.0.0.1 --directory ..\dist
```

Abre [el dashboard local](http://127.0.0.1:8000/). En **Cambiar fuente → MQTT en vivo**, escribe el mismo prefijo que configuraste en Wokwi y en el receptor. También puedes importar los CSV del receptor o consultar las lecturas de la prueba incluida.
