# OpenMV

1. **简介**

OpenMV Cam是一个可编程的摄像头，通过MicroPython语言，可以实现你的逻辑。

而且摄像头本身内置了一些图像处理算法，很容易使用。

对于需要**颜色识别**或是**机器视觉**的任务，我们通常使用OpenMV实现功能。

![Luban\_1750735421047276773d5\-a9c1\-42b4\-846f\-1db44f243b53\.jpg](图片和附件/Luban_1750735421047276773d5-a9c1-42b4-846f-1db44f243b53.jpg)

2. **开发介绍**

![Luban\_17507489954040e4140a4\-f37e\-4e07\-b639\-56700b5e8a81\.jpg](图片和附件/Luban_17507489954040e4140a4-f37e-4e07-b639-56700b5e8a81.jpg)

OpenMV的开发需要使用OpenMV IDE，下载地址https://openmv\.io/pages/download

IDE中比较重要的功能有左下角的**连接与运行**，中间的**代码区**，下方的**串行终端**，右侧的**帧缓冲区与直方图。**

**连接与运行**

未连接OpenMV时，连接和运行都是灰色，无法点击。

|![Luban\_175075047796434f30650\-358d\-4314\-b99c\-f884e271f118\.jpg](图片和附件/Luban_175075047796434f30650-358d-4314-b99c-f884e271f118.jpg)<br>|![Luban\_17507504898837a039f66\-f800\-4323\-99f8\-668e5d809dd8\.jpg](图片和附件/Luban_17507504898837a039f66-f800-4323-99f8-668e5d809dd8.jpg)<br>|
|---|---|

连接OpenMV后，连接图标会变成白色。此时点击连接图标，图标会变成插头图案，同时运行图标变为绿色三角形

|![Luban\_17507507268268e8c2e27\-113e\-4392\-8e55\-1f6071b23065\.jpg](图片和附件/Luban_17507507268268e8c2e27-113e-4392-8e55-1f6071b23065.jpg)<br>|**➡️**<br>|![Luban\_17507507499343f83fce7\-837a\-4f72\-8942\-46e5f32682b8\.jpg](图片和附件/Luban_17507507499343f83fce7-837a-4f72-8942-46e5f32682b8.jpg)<br>|![Luban\_1750750758707bc917af4\-6d3f\-4b05\-9a20\-25da6202f82a\.jpg](图片和附件/Luban_1750750758707bc917af4-6d3f-4b05-9a20-25da6202f82a.jpg)<br>|
|---|---|---|---|

此时单击绿色三角形，IDE将运行代码区内的程序，图标变为红色叉叉。

|![Luban\_1750750821949f400b579\-0f45\-4b98\-a970\-85904e632630\.jpg](图片和附件/Luban_1750750821949f400b579-0f45-4b98-a970-85904e632630.jpg)<br>|➡️|![Luban\_1750750884759dc7a7319\-bfd3\-4b47\-9d24\-095851e48429\.jpg](图片和附件/Luban_1750750884759dc7a7319-bfd3-4b47-9d24-095851e48429.jpg)<br>|
|---|---|---|

再次单击红色叉叉，程序停止运行，图标变回绿色三角形。

一般而言，平时调试程序时，只要停止再启动一次就可以运行新程序。

**代码区**

OpenMV基于Micro Python开发，语法和Python语言一致。

类似于arduino的setup\(\)与loop\(\)，OpenMV的程序也分为初始化部分与循环部分，以OpenMV默认文件为例：

```Python
# Untitled - By: 31857 - Tue Jun 24 2025

import sensor, image, time

sensor.reset()
sensor.set_pixformat(sensor.RGB565)
sensor.set_framesize(sensor.QVGA)
sensor.skip_frames(time = 2000)

clock = time.clock()

while(True):
    clock.tick()
    img = sensor.snapshot()
    print(clock.fps())
```

其中3\~10行为初始化部分，实现了对传感器的初始化。12\~15行为循环部分，实现了拍摄图像的功能，并把帧率打印到串口终端。

**串行终端**

![Luban\_17507755403913bc0bd37\-10bc\-4025\-bc72\-90fb6a6880a0\.jpg](图片和附件/Luban_17507755403913bc0bd37-10bc-4025-bc72-90fb6a6880a0.jpg)

类似于python IDLE的控制台，可以显示出print\(\)出的内容等。也可以执行简单的函数。

**帧缓冲区**

```Python
img = sensor.snapshot()
```

可以显示sensor\.snapshot\(\)捕获的图像，如果对img进行修改，也会反馈到帧缓冲区。

**直方图**

可以反馈帧缓冲区的图像中的像素在LAB空间或RGB空间的分布情况。

3. **常用功能**

OpenMV最常用的功能是**颜色识别**，以及**串口通讯。**

**颜色识别**

通过find\_blobs\(\)函数可以找到色块，下面介绍find\_blobs\(\)的细节。

```Python
image.find_blobs(thresholds, roi=Auto, x_stride=2, y_stride=1, invert=False, area_threshold=10, pixels_threshold=10, merge=False, margin=0, threshold_cb=None, merge_cb=None)
```

函数中的参数比较多，下面依次介绍：

|**参数名称**|**功能**|**说明**|
|---|---|---|
|thresholds<br>|目标颜色在LAB空间中的阈值|threshold是一个列表\(list\)，可以包含多个颜色，即使只识别一个颜色，也需要传入一个只包含一个颜色的列表。颜色是一个含有六个元素的元组\(turple\)。|
|roi|感兴趣区域\(region of interest\)|有的时候不希望在整个画面中搜索色块，可以指定只在一个矩形区域里识别，格式是在画面中的坐标元组\(x,y,w,h\)。|
|x\_stride|查找的色块的x方向上最小宽度的像素|默认为2，如果你只想查找宽度10个像素以上的色块，那么就设置这个参数为10|
|y\_stride |查找的色块的y方向上最小宽度的像素|默认为1，如果你只想查找宽度5个像素以上的色块，那么就设置这个参数为5|
|invert|反转阈值|把阈值以外的颜色作为阈值进行查找|
|area\_threshold|面积阈值|如果色块被框起来的面积小于这个值，会被过滤掉|
|pixels\_threshold|像素个数阈值|如果色块像素数量小于这个值，会被过滤掉|
|merge|合并|如果设置为True，那么合并所有重叠的blob为一个。|
|margin|边界|如果设置为1，那么两个blobs如果间距1一个像素点，也会被合并。|

**阈值**

一个颜色阈值的结构是这样的：

```Python
red = (minL, maxL, minA, maxA, minB, maxB)
```

元组里面的数值分别是L A B 的最大值和最小值。

**颜色阈值选择工具**
在OpenMV IDE中，先运行程序，在帧缓冲区中显示图案。

然后打开 工具➡️机器视觉➡️阈值编辑器

选择“帧缓冲区”可以获取帧缓冲区中的图像，“图片文件”可以选择本地的文件。

小技巧：如果停止程序运行，帧缓冲区的图片会保留，依然可以用于调节阈值，这一技巧在识别的角度比较刁钻时很好用。

（本地图片在智能农装立大功）

> 颜色识别例程
> 
> 

```Python
# Untitled - By: 31857 - Tue Jun 24 2025

import sensor, image, time

sensor.reset()
sensor.set_pixformat(sensor.RGB565)
sensor.set_framesize(sensor.QVGA)
sensor.skip_frames(time = 2000)

clock = time.clock()
GREEN = (0,100,-50,0,0,100)
while(True):
    clock.tick()
    img = sensor.snapshot()
    blobs = img.find_blobs([GREEN])
    if blobs:
        for blob in blobs:
            print(blob)
            img.draw_rectangle(blob.rect())
            img.draw_cross(blob.cx(),blob.cy())
    print(clock.fps())
```



draw\_rectangle\(\)和draw\_cross\(\)的作用是在指定位置绘制矩形与十字。因此在帧缓冲区能够绘制出识别到的每个色块的外接矩形与形心。

print\(blob\)将会在串口终端打印出识别到的每个blob，blob的结构如下：

```JSON
{"x":2"w":5, "h":3, "pixels":14, "cx":254, "cy":1, "rotation":0.115545, "code":1, "count":1, "perimeter":17, "roundness":0.343125}
```

blob是一个对象，micropython语言内置了很多方法：

|方法|功能|
|---|---|
|blob\.rect\(\)|返回这个色块的外框——矩形元组\(x, y, w, h\)，可以直接在image\.draw\_rectangle中使用。|
|blob\.x\(\)|返回色块的外框的x坐标（int），也可以通过blob\[0\]来获取。|
|blob\.y\(\)|返回色块的外框的y坐标（int），也可以通过blob\[1\]来获取。|
|blob\.w\(\)|返回色块的外框的宽度w（int），也可以通过blob\[2\]来获取。|
|blob\.h\(\)|返回色块的外框的高度h（int），也可以通过blob\[3\]来获取。|
|blob\.pixels\(\)|返回色块的像素数量（int），也可以通过blob\[4\]来获取。|
|blob\.cx\(\)|返回色块的外框的中心x坐标（int），也可以通过blob\[5\]来获取。|
|blob\.cy\(\)|返回色块的外框的中心y坐标（int），也可以通过blob\[6\]来获取。|
|blob\.rotation\(\)|返回色块的旋转角度（单位为弧度）（float）。如果色块类似一个铅笔，那么这个值为0\~180°。如果色块是一个圆，那么这个值是无用的。如果色块完全没有对称性，那么你会得到0\~360°，也可以通过blob\[7\]来获取。|
|blob\.count\(\) |如果merge=True，那么就会有多个blob被合并到一个blob，这个函数返回的就是这个的数量。如果merge=False，那么返回值总是1。也可以通过blob\[9\]来获取。|
|blob\.area\(\)|返回色块的外框的面积。应该等于\(w \* h\)|
|blob\.density\(\)|返回色块的密度。这等于色块的像素数除以外框的区域。如果密度较低，那么说明目标锁定的不是很好。<br>比如，识别一个红色的圆，返回的blob\.pixels\(\)是目标圆的像素点数，blob\.area\(\)是圆的外接正方形的面积。|

**串口通讯**

很多时候我们需要把OpenMV获取到的信息传递给其他MCU（比如Arduino），串口是一种简单且通用的方式。

串口通信分为同步通信与异步通信。同步通信的发送方和接收方共享一个公共的时钟信号，数据位的传输与时钟信号的边沿严格对齐，常见的如I2C,SPI；异步通信没有共享的时钟信号，通信双方事先约定好通信速率（波特率），常见的如UART。OpenMV所使用的通信协议是UART。

UART串口至少需要3根线：TXD，RXD，GND。TXD是发送端，RXD是接收端，GND是地线。 连线的时候，需要把OpenMV的RXD连到另一个MCU的TXD，TXD连到RXD。图示：

![Luban\_1750830087705f94979d8\-6125\-44b5\-ad92\-377037c921b9\.jpg](图片和附件/Luban_1750830087705f94979d8-6125-44b5-ad92-377037c921b9.jpg)

下面展示OpenMV与Arduino通信的示例程序：

```python
import time
from machine import UART
#from pyb import UART

# OpenMV4 H7 Plus, OpenMV4 H7, OpenMV3 M7, OpenMV2 M4 的UART(3)是P4-TX P5-RX
uart = UART(3, 115200)   #OpenMV RT 注释掉这一行，用下一行UART(1)
#uart = UART(1, 115200)  #OpenMV RT 用UART(1)这行，注释掉上一行UART(3)
# OpenMV RT 只有串口UART(1)，对应P4-TX P5-RX; OpenMV4 H7 Plus, OpenMV4 H7, OpenMV3 M7 的UART(1)是P0-RX P1-TX

while(True):
    if uart.any():                #如果收到消息
        uart.write("2")           #反馈消息
        
        print(uart.read(),end='')
        print("2")              #打印到串口终端
    time.sleep_ms(1000)

```

ARC俱乐部使用的OpenMV型号为OpenMV H7 Plus，通常使用UART\(3\)与Arduino通信。OpenMV与电脑之间的通信事实上也是UART串口，使用了UART\(1\)。

```C++
void setup(){
    // put your setup code here, to run once: 
    Serial.begin(9600);            //与电脑通信,波特率与IDE一致
    Serial1.begin(115200);         //波特率必须与OpenMV一致
    Serial1.write("5");            //发送启动命令
}

void loop(){
    // put your main code here, to run repeatedly:
    if(Serial1.available()){
        delay(500);                 //阻塞500ms
        Serial1.write("5");         //反馈消息
        
        Serial.print("5");
        Serial.println(Serial.read());
    }
｝

```

上述两段程序的功能是Arduino和OpenMV之间的双向通信，由Arduino发送启动命令，随后双方每隔500ms互相发送信息。

无论是OpenMV还是Arduino，串口传输来的信息并不会立即被处理，而是暂存在缓冲区中。如果Arduino的缓冲区中有暂存的信息，Serial1\.available\(\)的返回值为1（反之为0），OpenMV也是同理。

uart\.write\(\)与Serial1\.write\(\)的功能是传输信息，uart\.read\(\)与Serial1\.read\(\)的功能是读取信息。

Arduino mega 2560提供了四个UART接口：

|UART对象名|接收引脚（RX）|发送引脚（TX）|
|---|---|---|
|Serial|0|1|
|Serial1|19|18|
|Serial2|17|16|
|Serial3|15|14|

与OpenMV相似，Serial用来与电脑通信。要运行上文的例程，需要将Arduino的19与OpenMV的P4相连，18与P5相连。

附：Arduino mega 2560引脚图与OpenMV H7 Plus引脚图

|![Luban\_17508319988507d65581b\-27a9\-42ba\-beac\-70ccc885a8ed\.jpg](图片和附件/Luban_17508319988507d65581b-27a9-42ba-beac-70ccc885a8ed.jpg)<br>|<br>![Luban\_1750832003411cd21977b\-9ac4\-4714\-97d8\-869403ceb012\.png](图片和附件/Luban_1750832003411cd21977b-9ac4-4714-97d8-869403ceb012.png)<br>|
|---|---|





> 更多知识可以跳转：
> 
> 

【序言 · OpenMV中文入门教程】https://book\.openmv\.cc/

【OpenMV 中文文档】https://docs\.singtown\.com/micropython/zh/latest/openmvcam/index\.html

【OpenMV \- 从入门到实战！\(寻迹/串口通信/脱机调阈值/模板匹配\.\.\.\)\-哔哩哔哩】 https://b23\.tv/7bUvrzw

【一文搞懂UART通信协议】https://cloud\.tencent\.com/developer/article/2118929

