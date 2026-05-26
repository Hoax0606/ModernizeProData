package com.ksinfo.modernize_pro_data;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableAsync;

@SpringBootApplication
@EnableAsync   // RunExecutionListener 의 stage 실행이 startRun transaction commit 후 별 thread 에서 동작.
public class ModernizeProDataApplication {

	public static void main(String[] args) {
		// AWT/Swing 사용 (Site Settings 의 폴더 선택 다이얼로그 등).
		// 폐쇄망 PC 설치 배포 형태라 사용자 PC 에서 직접 native dialog 를 띄움.
		SpringApplication app = new SpringApplication(ModernizeProDataApplication.class);
		app.setHeadless(false);
		app.run(args);
	}

}
